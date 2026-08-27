import { createFileRoute } from "@tanstack/react-router";
import { calculateDeliveryFee, type DeliveryConfig } from "@/lib/delivery-distance.server";
import { normalizeStreet, similarity } from "@/lib/zonas-entrega.server";
import { brl, orderNumberFmt } from "@/lib/formatters";
import { sendWhatsappText, sendWhatsappMedia } from "@/lib/whatsapp-send.server";
import { isWithinBusinessHours, formatBusinessHoursText, type BusinessHourRange } from "@/lib/business-hours";
import { getEffectivePrice } from "@/lib/promotions";

// Envia todas as imagens do cardápio cadastradas em /loja/config → Imagens do
// cardápio, uma de cada vez, com um pequeno intervalo. Quando o cliente pede
// explicitamente o cardápio/menu, a imagem pode ser enviada independentemente
// do bairro. Esse envio nunca deve incluir links de iFood/99Food.
async function sendMenuImagesOnce(
  supabaseAdmin: any,
  conversationId: string,
  phone: string,
  force = false,   // true = cliente pediu explicitamente → envia mesmo se já enviou antes
): Promise<void> {
  try {
    if (!force) {
      // Verifica se o cardápio em imagem já foi enviado nesta conversa.
      // Impede reenvio em caso de race-condition (2 mensagens chegando juntas)
      // ou de o bot enviar de novo sem o cliente ter pedido.
      const { count } = await supabaseAdmin
        .from("whatsapp_messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId)
        .eq("direction", "out")
        .not("media_url", "is", null)
        .eq("media_type", "image");
      if ((count ?? 0) > 0) return; // já enviou — não repete
    }

    const { data: imgs } = await supabaseAdmin
      .from("menu_images")
      .select("url")
      .order("created_at", { ascending: true });
    const urls: string[] = (imgs ?? []).map((i: any) => i.url).filter(Boolean);
    if (!urls.length) return;
    for (let i = 0; i < urls.length; i++) {
      const res = await sendWhatsappMedia(supabaseAdmin, phone, urls[i], "image", i === 0 ? "Cardápio 👇" : undefined);
      if (res.ok) {
        await supabaseAdmin.from("whatsapp_messages").insert({
          conversation_id: conversationId,
          direction: "out",
          sender_type: "bot",
          body: i === 0 ? "Cardápio 👇" : null,
          media_url: urls[i],
          media_type: "image",
          external_id: res.externalId ?? null,
        });
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  } catch {
    /* falha silenciosa — não trava o atendimento se o storage/CDN estiver instável */
  }
}

// Evolution API manda os eventos de mensagem aqui.
// Fluxo:
//  1. Registra a conversa e a mensagem recebida no histórico do chat.
//  2. Se o admin já assumiu a conversa (bot_paused), não responde nada — só loga.
//  3. Se for imagem, tenta ler como comprovante de Pix.
//  4. Se for texto, roda a IA conversacional (com memória do pedido em construção,
//     cardápio e estoque ao vivo) até coletar tudo e fechar o pedido.

// ============================================================
// IA com failover automático: o ChatGPT (OpenAI) é o provedor PRINCIPAL —
// sempre é o primeiro tentado. Se a chave da OpenAI não estiver configurada,
// falhar ou ficar sem crédito, o sistema tenta automaticamente a chave do
// Groq cadastrada como reserva, na mesma requisição, sem o cliente perceber.
// Cadastre as duas chaves em /loja/config (Configurações → IA / Failover).
// ============================================================

type AiProvider = "openai" | "groq1";

const AI_PROVIDERS: Record<AiProvider, { endpoint: string; model: string; visionModel: string }> = {
  openai: {
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    visionModel: "gpt-4o-mini",
  },
  groq1: {
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    visionModel: "llama-3.2-90b-vision-preview",
  },
};

async function loadAiState(supabaseAdmin: any): Promise<{ openaiKey: string | null; groqKey: string | null; temperature: number }> {
  let { data, error } = await supabaseAdmin
    .from("store_config")
    .select("openai_api_key, groq_api_key, ai_temperature")
    .maybeSingle();
  // Compatibilidade enquanto a migration de ai_temperature ainda não foi
  // aplicada: preserva as chaves e usa 0.2 como padrão seguro.
  if (error) {
    const fallback = await supabaseAdmin
      .from("store_config")
      .select("openai_api_key, groq_api_key")
      .maybeSingle();
    data = fallback.data ? { ...fallback.data, ai_temperature: 0.2 } : null;
  }
  const rawTemperature = Number(data?.ai_temperature ?? 0.2);
  return {
    openaiKey: data?.openai_api_key || null,
    groqKey: data?.groq_api_key || null,
    temperature: Number.isFinite(rawTemperature) ? Math.max(0, Math.min(1, rawTemperature)) : 0.2,
  };
}

const AI_REQUEST_TIMEOUT_MS = 20000;

async function acquireWhatsappProcessingLock(supabaseAdmin: any, phone: string): Promise<boolean> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 3 * 60 * 1000).toISOString();
    // limpa somente lock expirado deste telefone
    await supabaseAdmin
      .from("whatsapp_processing_locks")
      .delete()
      .eq("phone", phone)
      .lt("expires_at", now.toISOString());
    const { error } = await supabaseAdmin
      .from("whatsapp_processing_locks")
      .insert({ phone, expires_at: expiresAt });
    if (!error) return true;
    // 23505 = outra mensagem do mesmo cliente está sendo processada
    if (String(error.code) !== "23505") {
      // migration ainda não aplicada: não derruba o atendimento
      if (/whatsapp_processing_locks|schema cache|relation/i.test(String(error.message ?? ""))) return true;
      console.error("[conversation-lock] falha ao adquirir lock:", error);
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function releaseWhatsappProcessingLock(supabaseAdmin: any, phone: string): Promise<void> {
  try {
    await supabaseAdmin.from("whatsapp_processing_locks").delete().eq("phone", phone);
  } catch {
    /* best effort */
  }
}

function extractPhoneFromEvolutionPayload(payload: any): string | null {
  const rawData = payload?.data ?? payload?.message ?? payload;
  const data = Array.isArray(rawData?.messages) ? rawData.messages[0] : rawData;
  const remoteJid: string = data?.key?.remoteJid ?? "";
  if (!remoteJid || remoteJid.endsWith("@g.us")) return null;
  const phone = remoteJid.split("@")[0].replace(/\D/g, "");
  return phone || null;
}

/** Chama o chat completions do ChatGPT (principal); se falhar, tenta o Groq (reserva) na mesma requisição. */
async function callChatCompletion(supabaseAdmin: any, body: any, useVision = false): Promise<any | null> {
  const { openaiKey, groqKey, temperature } = await loadAiState(supabaseAdmin);

  const order: { provider: AiProvider; key: string | null }[] = [
    { provider: "openai", key: openaiKey },
    { provider: "groq1", key: groqKey },
  ];

  for (const { provider, key } of order) {
    if (!key) continue; // essa chave não está configurada, pula pro próximo provedor
    const cfg = AI_PROVIDERS[provider];

    try {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ ...body, temperature: body.temperature ?? temperature, model: useVision ? cfg.visionModel : cfg.model }),
        signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error(`[ai-failover] ${provider} respondeu ${res.status}: ${await res.text().catch(() => "")}`);
        continue;
      }
      if (provider !== "openai") {
        console.log(`[ai-failover] ChatGPT falhou, usando reserva: ${provider}`);
      }
      return await res.json();
    } catch (err) {
      console.error(`[ai-failover] ${provider} falhou:`, err);
      continue;
    }
  }

  console.error("[ai-failover] ChatGPT e Groq (reserva) falharam ou não estão configurados");
  return null;
}

// ============================================================
// Utilidades de envio / storage
// ============================================================

async function sendWhatsappReply(phone: string, text: string): Promise<string | undefined> {
  // a decisão de qual provedor usar (Evolution ou Meta Cloud API) e toda a
  // humanização (pausa + "digitando...") ficam centralizadas em
  // src/lib/whatsapp-send.server.ts — aqui só delega
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const result = await sendWhatsappText(supabaseAdmin, phone, text);
  return result.externalId;
}

// ============================================================
// Conversa / histórico de chat (visível no painel em /loja/chat)
// ============================================================

async function getOrCreateConversation(supabaseAdmin: any, phone: string, pushName?: string) {
  const { data: existing, error: selectErr } = await supabaseAdmin
    .from("whatsapp_conversations")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();
  if (selectErr) throw new Error(`Falha ao buscar conversa (whatsapp_conversations select): ${selectErr.message}`);
  if (existing) return existing;

  const { data: created, error: insertErr } = await supabaseAdmin
    .from("whatsapp_conversations")
    .insert({ phone, customer_name: pushName || null })
    .select("*")
    .single();
  if (insertErr) {
    // Duas primeiras mensagens podem chegar quase juntas. Se outro webhook
    // criou a conversa entre o SELECT e o INSERT, recupera a linha existente
    // em vez de transformar uma condição normal de concorrência em erro 500.
    if (String(insertErr.code) === "23505") {
      const { data: raced } = await supabaseAdmin
        .from("whatsapp_conversations")
        .select("*")
        .eq("phone", phone)
        .maybeSingle();
      if (raced) return raced;
    }
    throw new Error(`Falha ao criar conversa (whatsapp_conversations insert): ${insertErr.message}`);
  }
  if (!created) throw new Error("whatsapp_conversations insert não retornou nenhuma linha");
  return created;
}

async function logMessage(
  supabaseAdmin: any,
  conversationId: string,
  patch: {
    direction: "in" | "out";
    sender_type: "customer" | "bot" | "admin";
    body?: string | null;
    media_url?: string | null;
    media_type?: string | null;
    external_id?: string | null;
  },
) {
  // IMPORTANTE: o cliente do Supabase NÃO lança exceção sozinho quando o
  // banco rejeita uma gravação (RLS, permissão, constraint) — ele só
  // devolve um campo `error`. Sem checar isso explicitamente, uma falha
  // aqui é 100% silenciosa: a mensagem "desaparece" (não é salva, não
  // aparece no chat do painel), mas o resto do fluxo continua normal como
  // se nada tivesse acontecido. Por isso agora verificamos e propagamos.
  const { error: insertErr } = await supabaseAdmin
    .from("whatsapp_messages")
    .insert({ conversation_id: conversationId, ...patch });
  if (insertErr) {
    console.error("[logMessage] falha ao gravar mensagem:", insertErr.message);
    try {
      await supabaseAdmin.rpc("record_system_alert", {
        _kind: "whatsapp_message_log_failed",
        _message: `Mensagem do WhatsApp (${patch.direction}) não foi salva no histórico: ${insertErr.message}`,
        _severity: "error",
      });
    } catch {
      /* alerta não pode quebrar o fluxo */
    }
    throw new Error(`Falha ao gravar mensagem (whatsapp_messages insert): ${insertErr.message}`);
  }
  await supabaseAdmin
    .from("whatsapp_conversations")
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: (patch.body || `[${patch.media_type ?? "mídia"}]`).slice(0, 140),
    })
    .eq("id", conversationId);
  if (patch.direction === "in") {
    const { data } = await supabaseAdmin
      .from("whatsapp_conversations")
      .select("unread_count")
      .eq("id", conversationId)
      .maybeSingle();
    await supabaseAdmin
      .from("whatsapp_conversations")
      .update({ unread_count: (data?.unread_count ?? 0) + 1 })
      .eq("id", conversationId);
  }
}

// ============================================================
// Helper: faz upload de mídia (base64) para o Supabase Storage
// bucket "chat-media" e devolve a URL pública permanente.
// Retorna null em caso de falha — não quebra o fluxo principal,
// a mensagem ainda é salva sem visualização de mídia no painel.
// ============================================================
async function uploadMediaToStorage(
  supabaseAdmin: any,
  base64: string,
  mimeType: string,
  conversationId: string,
  filename?: string,
): Promise<string | null> {
  try {
    const ext =
      mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg"
      : mimeType.includes("png") ? "png"
      : mimeType.includes("gif") ? "gif"
      : mimeType.includes("webp") ? "webp"
      : mimeType.includes("pdf") ? "pdf"
      : mimeType.includes("mp4") ? "mp4"
      : mimeType.includes("ogg") || mimeType.includes("opus") ? "ogg"
      : mimeType.includes("mp3") ? "mp3"
      : mimeType.includes("wav") ? "wav"
      : mimeType.includes("mpeg") ? "mp3"
      : "bin";
    const safeName = filename
      ? filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)
      : `${Date.now()}.${ext}`;
    const storagePath = `${conversationId}/${Date.now()}-${safeName}`;
    const buffer = Buffer.from(base64, "base64");
    const { error } = await supabaseAdmin.storage
      .from("chat-media")
      .upload(storagePath, buffer, { contentType: mimeType, upsert: true });
    if (error) {
      console.error("[uploadMediaToStorage] erro ao fazer upload:", error.message);
      return null;
    }
    const { data } = supabaseAdmin.storage.from("chat-media").getPublicUrl(storagePath);
    return data?.publicUrl ?? null;
  } catch (err: any) {
    console.error("[uploadMediaToStorage] exceção:", err?.message ?? err);
    return null;
  }
}

async function replyAndLog(
  supabaseAdmin: any,
  conversationId: string,
  phone: string,
  text: string,
  opts?: { systemMessage?: boolean },
) {
  const externalId = await sendWhatsappReply(phone, text);
  // Mensagens automáticas do sistema (comprovante do pedido, chave Pix, fallback)
  // são marcadas com media_type "system": aparecem normal no chat do painel, mas
  // FICAM FORA do histórico que a IA lê — se entram, o modelo passa a imitar o
  // estilo delas (emojis, blocos, apresentações) e repete padrão em loop.
  await logMessage(supabaseAdmin, conversationId, {
    direction: "out",
    sender_type: "bot",
    body: text,
    media_type: opts?.systemMessage ? "system" : null,
    external_id: externalId ?? null,
  });
}

// ============================================================
// Comprovante de Pix (imagem)
// ============================================================

async function analyzeReceipt(
  supabaseAdmin: any,
  imageBase64: string,
  mimeType: string,
): Promise<{ is_receipt: boolean; amount: number | null; confidence: "high" | "medium" | "low" }> {
  const fallback = { is_receipt: false, amount: null, confidence: "low" as const };

  const json = await callChatCompletion(
    supabaseAdmin,
    {
      messages: [
        {
          role: "system",
          content:
            "Você analisa imagens de comprovante de pagamento Pix enviadas por clientes de um delivery. Diga se a imagem É um comprovante de Pix concluído (não pendente, não agendado) e qual o valor pago.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Essa imagem é um comprovante de Pix já concluído? Qual o valor?",
            },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "register_receipt",
            description: "Registra a análise do comprovante",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                is_receipt: {
                  type: "boolean",
                  description: "true somente se for um comprovante de Pix CONCLUÍDO",
                },
                amount: {
                  type: "number",
                  description: "valor pago em reais, ou null se não identificado",
                },
                confidence: { type: "string", enum: ["high", "medium", "low"] },
              },
              required: ["is_receipt", "confidence"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "register_receipt" } },
    },
    true,
  );

  if (!json) return fallback;
  const call = json?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return fallback;
  try {
    const parsed = JSON.parse(call.function.arguments);
    return {
      is_receipt: !!parsed.is_receipt,
      amount: parsed.amount ?? null,
      confidence: parsed.confidence ?? "low",
    };
  } catch {
    return fallback;
  }
}

async function handleReceiptImage(
  supabaseAdmin: any,
  conversationId: string,
  phone: string,
  imageBase64: string,
  mimeType: string,
) {
  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, order_number, total, payment_status, status")
    .eq("customer_phone", phone)
    .eq("payment_method", "pix")
    .neq("payment_status", "paid")
    .not("status", "in", "(cancelled,failed)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!order) {
    await replyAndLog(
      supabaseAdmin,
      conversationId,
      phone,
      "Recebi a imagem. Para eu conseguir te ajudar corretamente, me diga por texto o que você precisa.",
      { systemMessage: true },
    );
    return;
  }

  const analysis = await analyzeReceipt(supabaseAdmin, imageBase64, mimeType);
  if (!analysis.is_receipt) {
    await replyAndLog(
      supabaseAdmin,
      conversationId,
      phone,
      "Recebi a imagem. Se ela for referente ao seu pedido, me diga por texto o que você precisa.",
      { systemMessage: true },
    );
    return;
  }
  if (analysis.confidence === "low") {
    await replyAndLog(
      supabaseAdmin,
      conversationId,
      phone,
      `Recebi o possível comprovante do pedido *${orderNumberFmt(order.order_number)}*. A loja vai conferir manualmente antes de confirmar o pagamento.`,
      { systemMessage: true },
    );
    return;
  }

  const path = `${order.id}/${Date.now()}.jpg`;
  const bytes = Buffer.from(imageBase64, "base64");
  await supabaseAdmin.storage.from("payment-receipts").upload(path, bytes, { contentType: mimeType, upsert: true });
  const { data: pub } = supabaseAdmin.storage.from("payment-receipts").getPublicUrl(path);

  const amountMatches = analysis.amount == null || Math.abs(analysis.amount - Number(order.total)) < 0.05;

  // A IA pode reconhecer que a imagem parece um comprovante, mas NÃO tem
  // autoridade para marcar o Pix como pago. Liquidação financeira só pode ser
  // confirmada por integração bancária ou por um operador humano.
  await supabaseAdmin
    .from("orders")
    .update({ payment_receipt_url: pub.publicUrl })
    .eq("id", order.id);

  await replyAndLog(
    supabaseAdmin,
    conversationId,
    phone,
    amountMatches
      ? `Recebi o comprovante do pedido *${orderNumberFmt(order.order_number)}*. A loja vai conferir o pagamento e confirmar por aqui.`
      : `Recebi o comprovante do pedido *${orderNumberFmt(order.order_number)}*, mas o valor identificado não bateu com o total (*${brl(order.total)}*). A loja vai conferir manualmente.`,
    { systemMessage: true },
  );
}

// ============================================================
// Cardápio e estoque ao vivo (o que a IA "sabe" sobre a loja)
// ============================================================

async function loadCatalogText(
  supabaseAdmin: any,
): Promise<{ catalogText: string; unavailableText: string; categoriesText: string }> {
  const { data: products } = await supabaseAdmin
    .from("products")
    .select("id,name,description,customer_ingredients,category,sale_price,promotion_active,promotion_price,promotion_type,promotion_start_at,promotion_end_at,promotion_days_of_week,promotion_time_start,promotion_time_end,promotion_label")
    .eq("active", true)
    .order("category")
    .order("name");

  const { data: outIngredients } = await supabaseAdmin
    .from("ingredients")
    .select("id")
    .eq("track_stock", true)
    .lte("stock_quantity", 0);
  let unavailableNames: string[] = [];
  if (outIngredients?.length) {
    const ids = outIngredients.map((i: any) => i.id);
    const { data: affected } = await supabaseAdmin.from("recipe_items").select("product_id").in("ingredient_id", ids);
    const productIds = [...new Set((affected ?? []).map((r: any) => r.product_id))];
    if (productIds.length) {
      const { data: unavailableProducts } = await supabaseAdmin.from("products").select("name").in("id", productIds);
      unavailableNames = (unavailableProducts ?? []).map((p: any) => p.name);
    }
  }

  // Composição de cada produto (quais insumos entram nele) — assim a IA sabe
  // responder qualquer pergunta sobre ingredientes com segurança, sem nunca
  // precisar dizer que "não tem essa informação".
  const productIds = (products ?? []).map((p: any) => p.id);
  const ingredientsByProduct: Record<string, string[]> = {};
  if (productIds.length) {
    const { data: recipeRows } = await supabaseAdmin
      .from("recipe_items")
      .select("product_id, ingredient_id, ingredients(name)")
      .in("product_id", productIds);
    for (const row of recipeRows ?? []) {
      const ingName = row.ingredients?.name;
      if (!ingName) continue;
      (ingredientsByProduct[row.product_id] ||= []).push(ingName);
    }
  }

  const availableProducts = (products ?? []).filter((p: any) => !unavailableNames.includes(p.name));

  // Categorias REAIS cadastradas no sistema — a IA usa ISSO, e só isso, pra
  // responder "o que vocês têm?". Isso existe porque a IA já respondeu com
  // uma categoria inventada, que não existe na loja, copiando um exemplo
  // genérico que sobrou no prompt em vez de olhar o cardápio real. Calculando
  // a lista de categorias aqui, em código, a partir do banco, não sobra
  // espaço pra ela inventar nada: ou a categoria está nesta lista, ou ela
  // não existe na loja.
  const categoryOrder: string[] = [];
  for (const p of availableProducts) {
    const cat = (p.category || "Outros").trim();
    if (!categoryOrder.includes(cat)) categoryOrder.push(cat);
  }
  const categoriesText = categoryOrder.length ? categoryOrder.join(", ") : "(nenhuma categoria cadastrada ainda)";

  // Cardápio agrupado por categoria (com cabeçalho), pra ficar estruturalmente
  // claro pra IA quais produtos pertencem a qual categoria real.
  const byCategory: Record<string, any[]> = {};
  for (const p of availableProducts) {
    const cat = (p.category || "Outros").trim();
    (byCategory[cat] ||= []).push(p);
  }
  const catalogText =
    categoryOrder
      .map((cat) => {
        const items = byCategory[cat]
          .map((p: any) => {
            const recipeIngs = ingredientsByProduct[p.id];
            // Fonte principal para responder ao cliente: campo explícito do cadastro do produto.
            // A ficha técnica (recipe_items) fica como fallback para produtos antigos ainda não preenchidos.
            const customerIngredients = String(p.customer_ingredients || "").trim();
            const composition = customerIngredients
              ? ` | Ingredientes: ${customerIngredients}`
              : recipeIngs?.length
                ? ` | Ingredientes: ${recipeIngs.join(", ")}`
                : " | Ingredientes: não cadastrados — se o cliente perguntar, informe que vai confirmar com a equipe; nunca invente";
            const effective = getEffectivePrice(p);
            const promo = effective.isPromotion ? ` (promoção${p.promotion_label ? `: ${p.promotion_label}` : ""}; preço normal R$ ${effective.listPrice.toFixed(2).replace(".", ",")})` : "";
            return `- ${p.name}${p.description ? " — " + p.description : ""} — R$ ${effective.price.toFixed(2).replace(".", ",")}${promo}${composition}`;
          })
          .join("\n");
        return `[${cat}]\n${items}`;
      })
      .join("\n\n") || "(cardápio vazio no momento — nenhum produto cadastrado ou ativo)";

  const unavailableText = unavailableNames.length
    ? unavailableNames.map((n) => `- ${n} (sem estoque hoje)`).join("\n")
    : "";

  return { catalogText, unavailableText, categoriesText };
}

// ============================================================
// Rascunho do pedido (memória de trabalho por conversa)
// ============================================================

type DraftItem = { product_name: string; quantity: number; notes?: string | null };
type Draft = {
  customer_name?: string | null;
  delivery_mode?: "delivery" | "pickup" | null;
  address_street?: string | null;
  address_number?: string | null;
  address_complement?: string | null;
  address_neighborhood?: string | null;
  address_city?: string | null;
  address_reference?: string | null;
  items: DraftItem[];
  payment_method?: "pix" | "card" | null;
  card_type?: "credit" | "debit" | null;
  payment_timing?: "now" | "delivery" | null;
  change_for?: number | null;
  notes?: string | null;
  estimated_delivery_fee?: number | null;
  estimated_distance_km?: number | null;
  out_of_delivery_area?: boolean;
  failed_finalize_attempts?: number;
  awaiting_final_confirmation?: boolean;
};

// Se o rascunho ficou parado por muito tempo (cliente sumiu, teste antigo,
// pedido abandonado), ele NÃO deve ser tratado como "já confirmado" numa
// conversa nova — isso é o que causava a IA fechar pedido sozinha em cima de
// dados velhos assim que o cliente mandava um simples "bom dia". Qualquer
// rascunho com conteúdo e sem atividade há mais de 20min é limpo
// automaticamente antes de começar a conversa — janela curta de propósito,
// já que o cliente pode voltar a falar rápido e um pedido real raramente
// fica parado tanto tempo no meio da conversa.
const DRAFT_STALE_MS = 20 * 60 * 1000;

async function loadOrCreateDraft(supabaseAdmin: any, conversationId: string): Promise<Draft> {
  const { data, error: selectErr } = await supabaseAdmin
    .from("order_drafts")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (selectErr) throw new Error(`Falha ao buscar rascunho (order_drafts select): ${selectErr.message}`);

  if (data) {
    const hasContent = Boolean(
      data.customer_name || data.address_street || data.payment_method || (data.items ?? []).length,
    );
    const ageMs = data.updated_at ? Date.now() - new Date(data.updated_at).getTime() : Infinity;
    if (hasContent && ageMs > DRAFT_STALE_MS) {
      const cleared = {
        customer_name: null,
        delivery_mode: null,
        address_street: null,
        address_number: null,
        address_complement: null,
        address_neighborhood: null,
        address_city: null,
        address_reference: null,
        items: [],
        payment_method: null,
        card_type: null,
        payment_timing: null,
        change_for: null,
        notes: null,
        estimated_delivery_fee: null,
        estimated_distance_km: null,
        out_of_delivery_area: false,
        awaiting_final_confirmation: false,
        updated_at: new Date().toISOString(),
      };
      await supabaseAdmin.from("order_drafts").update(cleared).eq("conversation_id", conversationId);
      return { items: [] };
    }
    return { ...data, items: data.items ?? [] };
  }

  const { error: insertErr } = await supabaseAdmin
    .from("order_drafts")
    .insert({ conversation_id: conversationId, items: [] });
  if (insertErr) throw new Error(`Falha ao criar rascunho (order_drafts insert): ${insertErr.message}`);
  return { items: [] };
}

function summarizeDraft(d: Draft): string {
  const lines: string[] = [];
  if (d.customer_name) lines.push(`Nome: ${d.customer_name}`);
  if (d.delivery_mode)
    lines.push(`Modo: ${d.delivery_mode === "pickup" ? "Retirada no local (sem entrega)" : "Entrega"}`);
  if (d.delivery_mode !== "pickup") {
    if (d.address_street)
      lines.push(
        `Endereço: ${d.address_street}, ${d.address_number ?? "?"}${d.address_complement ? " — " + d.address_complement : ""}${d.address_neighborhood ? " — " + d.address_neighborhood : ""}`,
      );
    if (d.address_reference) lines.push(`Referência: ${d.address_reference}`);
  }
  if (d.items?.length)
    lines.push(
      `Itens: ${d.items.map((i) => `${i.quantity}x ${i.product_name}${i.notes ? " (" + i.notes + ")" : ""}`).join(", ")}`,
    );
  if (d.payment_method)
    lines.push(
      `Pagamento: ${d.payment_method === "pix" ? "Pix" : `Cartão${d.card_type === "credit" ? " de crédito" : d.card_type === "debit" ? " de débito" : ""}`}`,
    );
  if (d.payment_timing)
    lines.push(`Quando paga: ${d.payment_timing === "now" ? "agora, no fechamento" : "na entrega/retirada"}`);
  if (d.delivery_mode !== "pickup") {
    if (d.out_of_delivery_area)
      lines.push(
        `⚠️ ATENÇÃO: esse endereço está FORA da área de entrega do entregador fixo — siga o fluxo de REDIRECIONAMENTO FORA DE ÁREA (iFood/99Food), não finalize o pedido.`,
      );
    else if (d.estimated_delivery_fee != null)
      lines.push(
        `Taxa de entrega calculada pra esse endereço: R$ ${Number(d.estimated_delivery_fee).toFixed(2).replace(".", ",")}${d.estimated_distance_km != null ? ` (${d.estimated_distance_km.toFixed(1)} km da loja)` : ""}`,
      );
  }
  return lines.length ? lines.join("\n") : "(nada coletado ainda)";
}

async function buildFinalConfirmationSummary(
  supabaseAdmin: any,
  d: Draft,
): Promise<{ text: string; subtotal: number; deliveryFee: number; total: number; unmatched: string[] }> {
  const { data: products } = await supabaseAdmin
    .from("products")
    .select("id,name,sale_price,promotion_active,promotion_price,promotion_type,promotion_start_at,promotion_end_at,promotion_days_of_week,promotion_time_start,promotion_time_end,promotion_label")
    .eq("active", true);
  const productList = products ?? [];
  const { findProductMatch } = await import("@/lib/product-match.server");
  const unmatched: string[] = [];
  const pricedItems = (d.items ?? []).map((it) => {
    const match = findProductMatch(productList, it.product_name);
    if (!match) unmatched.push(it.product_name);
    const price = match ? getEffectivePrice(match).price : 0;
    return {
      name: match?.name ?? it.product_name,
      quantity: Math.max(1, Math.round(Number(it.quantity) || 1)),
      price,
      notes: it.notes ?? null,
    };
  });
  const subtotal = pricedItems.reduce((sum, it) => sum + it.price * it.quantity, 0);
  const deliveryFee = d.delivery_mode === "pickup" ? 0 : Number(d.estimated_delivery_fee ?? 0);
  const total = subtotal + deliveryFee;
  const payment =
    d.payment_method === "pix"
      ? `Pix (${d.payment_timing === "now" ? "agora" : "na entrega"})`
      : d.payment_method === "card"
        ? `Cartão ${d.card_type === "credit" ? "de crédito" : d.card_type === "debit" ? "de débito" : ""} na entrega`.replace(/\\s+/g, " ")
        : "—";
  const address =
    d.delivery_mode === "pickup"
      ? "Retirada no local"
      : [d.address_street && `${d.address_street}, ${d.address_number ?? ""}`, d.address_complement, d.address_neighborhood]
          .filter(Boolean)
          .join(" — ");
  const itemsText = pricedItems
    .map((it) => `- ${it.quantity}x ${it.name}${it.notes ? ` (${it.notes})` : ""} — ${brl(it.price * it.quantity)}`)
    .join("\n");
  const text =
    `Aqui está o resumo do seu pedido:\n\n` +
    `*Nome:* ${d.customer_name ?? "—"}\n` +
    `*Modo:* ${d.delivery_mode === "pickup" ? "Retirada" : "Entrega"}\n` +
    `*${d.delivery_mode === "pickup" ? "Retirada" : "Endereço"}:* ${address || "—"}\n` +
    `*Itens:*\n${itemsText || "—"}\n` +
    `*Pagamento:* ${payment}\n` +
    `*Subtotal:* ${brl(subtotal)}\n` +
    (d.delivery_mode === "pickup" ? "" : `*Taxa de entrega:* ${brl(deliveryFee)}\n`) +
    `*Total a pagar:* ${brl(total)}\n\n` +
    `Está tudo correto?`;
  return { text, subtotal, deliveryFee, total, unmatched };
}


async function loadLastOrderText(supabaseAdmin: any, phone: string): Promise<string | null> {
  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, order_number, status, total, created_at")
    .eq("customer_phone", phone)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!order) return null;

  const { data: items } = await supabaseAdmin
    .from("order_items")
    .select("product_name, quantity")
    .eq("order_id", order.id);
  const itemsText = (items ?? []).map((i: any) => `${i.quantity}x ${i.product_name}`).join(", ");
  const statusLabel: Record<string, string> = {
    pending_review: "aguardando confirmação da loja",
    pending: "confirmado, entrou na fila",
    preparing: "em preparação",
    ready_pickup: "pronto, aguardando entregador",
    out_for_delivery: "saiu para entrega",
    delivered: "já entregue",
    failed: "teve problema na entrega",
    cancelled: "cancelado",
  };
  const when = new Date(order.created_at).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Pedido #${order.order_number}, feito em ${when} — status: ${statusLabel[order.status] ?? order.status} — total: R$ ${Number(order.total).toFixed(2).replace(".", ",")}${itemsText ? ` — itens: ${itemsText}` : ""}`;
}

async function loadLastAddressText(supabaseAdmin: any, phone: string): Promise<string | null> {
  // ── 1. Tenta o endereço confirmado salvo no perfil do lead (mais confiável,
  //       foi gravado após a última entrega concluída)
  const { data: lead } = await supabaseAdmin
    .from("leads")
    .select("address_street, address_number, address_complement, address_neighborhood, address_city, address_reference, last_delivery_fee")
    .eq("phone", phone)
    .maybeSingle();

  if (lead?.address_street) {
    const parts = [
      lead.address_number
        ? `${lead.address_street}, ${lead.address_number}`
        : lead.address_street,
      lead.address_complement  || null,
      lead.address_neighborhood || null,
      lead.address_city         || null,
      lead.address_reference ? `referência: ${lead.address_reference}` : null,
    ].filter(Boolean);

    const feeText = lead.last_delivery_fee != null
      ? ` | Taxa de entrega cobrada na última vez: R$ ${Number(lead.last_delivery_fee).toFixed(2).replace(".", ",")}`
      : "";

    return parts.join(" — ") + feeText;
  }

  // ── 2. Fallback: busca no histórico de pedidos (clientes que ainda não têm
  //       o endereço migrado para o perfil de lead)
  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("address_street, address_number, address_complement, address_neighborhood, address_reference")
    .eq("customer_phone", phone)
    .not("address_street", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!order?.address_street) return null;

  const parts = [
    order.address_street && order.address_number ? `${order.address_street}, ${order.address_number}` : null,
    order.address_complement,
    order.address_neighborhood,
    order.address_reference ? `referência: ${order.address_reference}` : null,
  ].filter(Boolean);
  return parts.join(" — ");
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "update_order_draft",
      description:
        "Atualiza os dados já coletados do pedido em andamento nesta conversa. Chame sempre que o cliente informar ou confirmar algo novo (nome, endereço, itens, pagamento).",
      parameters: {
        type: "object",
        properties: {
          customer_name: { type: "string" },
          delivery_mode: {
            type: "string",
            enum: ["delivery", "pickup"],
            description: "'pickup' se o cliente disser que vai buscar/retirar na loja, 'delivery' se for entrega",
          },
          address_street: { type: "string" },
          address_number: { type: "string" },
          address_complement: { type: "string" },
          address_neighborhood: { type: "string" },
          address_city: { type: "string" },
          address_reference: { type: "string" },
          items: {
            type: "array",
            description:
              "Lista COMPLETA e atualizada dos itens do pedido — substitui a lista anterior inteira, não é incremental.",
            items: {
              type: "object",
              properties: {
                product_name: { type: "string", description: "nome EXATO de um item do cardápio" },
                quantity: { type: "number" },
                notes: { type: "string" },
              },
              required: ["product_name", "quantity"],
            },
          },
          payment_method: { type: "string", enum: ["pix", "card"] },
          card_type: { type: "string", enum: ["credit", "debit"], description: "Obrigatório quando payment_method=card: credit para crédito à vista, debit para débito." },
          payment_timing: { type: "string", enum: ["now", "delivery"] },
          notes: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finalize_order",
      description:
        "Fecha e registra definitivamente o pedido. Só chame quando TODOS os dados obrigatórios já tiverem sido confirmados pelo cliente: nome, endereço completo, itens, forma de pagamento, e se paga agora ou na entrega.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "update_active_order_items",
      description:
        "Atualiza um pedido JÁ CRIADO e ainda ativo quando o cliente pedir alteração de itens, quantidade, inclusão ou troca. Envie a lista COMPLETA de como o pedido deve ficar depois da alteração. O sistema recalcula subtotal e total e informa os novos valores ao cliente.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "Lista COMPLETA dos itens que devem permanecer no pedido após a alteração.",
            items: {
              type: "object",
              properties: {
                product_name: { type: "string", description: "Nome do produto ativo no sistema" },
                quantity: { type: "number" },
                notes: { type: "string" },
              },
              required: ["product_name", "quantity"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_active_order_item",
      description:
        "Remove ou reduz um item de um pedido JÁ CRIADO e ainda ativo quando o cliente pedir cancelamento de apenas um item. O sistema recalcula automaticamente os valores e informa o novo total.",
      parameters: {
        type: "object",
        properties: {
          product_name: { type: "string", description: "Nome do item que o cliente quer cancelar/remover" },
          quantity: { type: "number", description: "Quantidade a remover. Se omitida, remove o item inteiro." },
        },
        required: ["product_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_active_order",
      description:
        "Cancela imediatamente o pedido JÁ CRIADO e ainda ativo quando o cliente pedir cancelamento do pedido inteiro. Não precisa aguardar aprovação da loja. Registre que o cancelamento foi solicitado pelo cliente via WhatsApp.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Motivo informado pelo cliente, se houver" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_order_cancellation",
      description:
        "LEGADO: use somente se cancel_active_order não estiver disponível. O fluxo normal de cancelamento total deve usar cancel_active_order.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "o motivo que o cliente deu pra querer cancelar" },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_place_address",
      description:
        "Descobre o endereço real (rua e principalmente o BAIRRO) de um estabelecimento, ponto comercial ou referência que o cliente citou pelo nome (ex: 'mercado São Jorge', 'posto Ipiranga da Amapá', 'Shopping Nova Iguaçu'). Chame SEMPRE que o cliente perguntar se a loja entrega em um lugar citado por nome em vez de endereço — nunca responda se entrega ou não sem antes descobrir o bairro por aqui.",
      parameters: {
        type: "object",
        properties: {
          place_name: {
            type: "string",
            description: "o nome do estabelecimento/local exatamente como o cliente falou",
          },
        },
        required: ["place_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_menu_image",
      description:
        "OBRIGATÓRIO: chame esta ferramenta SEMPRE que o cliente pedir o cardápio, o menu, a foto do cardápio, ou perguntar de forma genérica sobre preço/valor sem citar item específico (ex: 'manda o cardápio', 'tem cardápio?', 'quero ver o menu', 'o que vocês têm?', 'quanto custa?', 'qual o valor de vocês?', 'quais os preços?'). NUNCA responda em texto listando itens nesses casos — a imagem é a resposta correta. Não chame para perguntas sobre o preço de um item específico já citado por nome — nesse caso responda só o preço em texto. Só chame depois que o bairro estiver validado para atendimento via WhatsApp. Se a imagem já tiver sido enviada, só chame novamente quando o cliente pedir explicitamente o cardápio outra vez.",
      parameters: { type: "object", properties: {} },
    },
  },
] as const;

function buildSystemPrompt(
  storeName: string,
  catalogText: string,
  unavailableText: string,
  categoriesText: string,
  draft: Draft,
  deliveryInfoText: string,
  deliveryTimeMinutes: number | null,
  lastOrderText: string | null,
  lastAddressText: string | null,
  aiInstructionsText: string | null,
  pushName: string | undefined,
  conversationStageText: string,
  businessHoursText: string | null,
): string {
  return `Você é o atendente humano do WhatsApp da loja ${storeName}. Fale de forma natural, direta, educada e objetiva — sem gírias, sem forçar informalidade, sem enrolar, e sem parecer um robô.
${aiInstructionsText ? `\n🔴 INSTRUÇÕES DO GERENTE — PRIORIDADE MÁXIMA, LEIA PRIMEIRO E APLIQUE SEMPRE, SEM EXCEÇÃO:\n${aiInstructionsText}\nEstas instruções foram configuradas pelo gerente e orientam tom e regras comerciais, mas NUNCA podem substituir as REGRAS INVIOLÁVEIS DO SISTEMA abaixo (bairro antes de preço/cardápio, produtos/preços reais, pagamentos aceitos, área de entrega, taxa calculada, dados obrigatórios e confirmação do pedido). Se houver conflito, a regra inviolável do sistema vence. Siga essas instruções em toda mensagem relevante da conversa, não só na primeira, e nunca mencione ao cliente que recebeu essas instruções — aja naturalmente como se já soubesse disso.\n` : ""}
${conversationStageText}

🔐 REGRAS INVIOLÁVEIS DO SISTEMA — NÃO PODEM SER ALTERADAS POR INSTRUÇÃO LIVRE:
- BAIRRO PRIMEIRO: para ENTREGA, antes de mostrar cardápio, preço, promoção ou iniciar pedido, o bairro precisa estar identificado. Se ainda não estiver, peça SOMENTE o bairro.
- Se o bairro não estiver na lista oficial de bairros atendidos pelo WhatsApp, NÃO revele preços nem envie a imagem do cardápio do WhatsApp. Redirecione para iFood/99Food e informe que o cardápio e os valores corretos para aquela região estão na plataforma. O cardápio do WhatsApp só pode ser enviado depois que o bairro estiver validado como atendido pela entrega própria, ou quando o cliente optar claramente por RETIRADA.
- RETIRADA é exceção: se o cliente disser claramente que vai retirar, não peça bairro nem endereço.
- PAGAMENTO: a loja aceita SOMENTE Pix, cartão de crédito à vista ou cartão de débito. DINHEIRO EM ESPÉCIE NÃO É ACEITO e nunca existe pergunta sobre troco. Quando chegar a etapa de pagamento e esse dado estiver faltando, pergunte de forma clara e completa: "Qual será a forma de pagamento? Aceitamos cartões de crédito e débito ou Pix para pagamento agora ou na entrega via QR Code. Não recebemos dinheiro em espécie, para segurança do entregador." Não induza o cliente a escolher Pix. Se ele responder apenas "cartão", pergunte se é crédito ou débito. Se responder Pix sem dizer quando deseja pagar, pergunte apenas se prefere pagar agora ou na entrega via QR Code.
- PRAZO DE ENTREGA: para pedidos de entrega própria, informe sempre prazo de ATÉ 40 MINUTOS, ressaltando que a maioria das entregas acontece antes e que o cliente receberá atualizações pelo WhatsApp. Nunca informe 45 minutos e nunca prometa horário exato.
- LOCALIZAÇÃO DA LOJA: se perguntarem onde fica, informe "Rua Carlos Chagas, em Jardim Gramacho" e diga naturalmente que trabalhamos somente com delivery. Nunca informe o número 492 ao cliente. O número existe apenas para uso interno/cálculo de rota.
- PREÇO: use exclusivamente o preço efetivo do CARDÁPIO ATIVO AGORA; quando houver promoção ativa no sistema, esse preço promocional é o valor válido.
- Não ofereça adicionais pagos, bordas, molhos ou complementos que não existam como produto/opção estruturada no sistema. Observações como “sem ingrediente” podem ser registradas, mas nunca invente cobrança adicional.
- Não confirme Pix apenas por foto de comprovante: informe somente que o comprovante foi recebido e será conferido.

🙏 EDUCAÇÃO OBRIGATÓRIA EM TODA SOLICITAÇÃO: sempre que pedir qualquer dado, confirmação ou esclarecimento ao cliente, use linguagem cordial e inclua "por favor" ou uma construção equivalente realmente educada (ex.: "poderia me informar ..., por favor?"). Nunca dê ordens secas como "informe o endereço", "mande o bairro" ou "diga o número". Ao receber uma informação solicitada, agradeça quando for natural. A frase oficial após um bairro atendido é: "Obrigado pela informação! Em que posso ajudar? Gostaria de ver nosso cardápio?".

🧠 NÃO SEJA REPETITIVO: antes de responder, compare sua resposta com as últimas mensagens enviadas no histórico. Se a mesma orientação já foi dada e o cliente insistir, responda de forma mais curta e com palavras diferentes, sem copiar a mensagem anterior. Nunca repita saudação, links, regras ou explicações desnecessariamente. O cardápio em imagem só pode ser enviado novamente quando o cliente pedir explicitamente o cardápio de novo.

📱 FORMATAÇÃO DAS MENSAGENS — MUITO IMPORTANTE: você está escrevendo no WhatsApp, formate como atendente profissional:\n- Use *asterisco* pra destacar valores, produtos e confirmações (ex: *R$ 45,00*, *pedido confirmado*).\n- Use quebra de linha SIMPLES (sem linha em branco) entre itens de lista. Só use parágrafo separado (linha em branco) quando mudar completamente de assunto — no máximo uma vez por mensagem.\n- Emojis com moderação (🍔 📍 💳 ✅) — 1 a 2 por mensagem, só onde faz sentido.\n- Itens do pedido: uma linha por item, sem espaço entre eles.\n- Mensagem profissional é compacta e direta — evite espaçamentos excessivos.

📍 INÍCIO DA CONVERSA: para atendimento de ENTREGA, a primeira informação operacional é sempre o BAIRRO. Não pergunte nome, endereço completo, forma de pagamento ou itens antes de validar o bairro. Depois que o bairro for validado como atendido pelo WhatsApp, agradeça e pergunte de forma natural em que pode ajudar. Em conversa já em andamento, nunca repita saudação nem volte a pedir um dado já confirmado.

🚫 CARDÁPIO EM TEXTO: nunca liste o cardápio inteiro em texto. Para ENTREGA, o cardápio do WhatsApp só pode ser enviado depois que o bairro estiver validado como atendido pelo entregador próprio. Se o bairro for externo, NÃO envie a imagem do cardápio do WhatsApp: redirecione para a plataforma, onde ficam os preços e o cardápio daquela região. Se ainda não souber o bairro, peça o bairro educadamente primeiro. Para RETIRADA, o cardápio do WhatsApp pode ser enviado quando solicitado. Pergunta sobre item específico também respeita a regra de bairro antes de revelar preço.

🎯 RESPONDA SÓ O QUE FOI PERGUNTADO — REGRA MÁXIMA DE TODO O ATENDIMENTO: cada resposta sua trata SOMENTE do que o cliente pediu ou perguntou naquela mensagem, nunca um pacote de informações extras que ele não pediu. Isso vale pra CADA etapa da conversa, não só pra saudação inicial:
- Cliente ainda não informou bairro e não declarou retirada → peça somente o bairro, com educação e "por favor", mesmo que tenha perguntado preço ou cardápio.
- 📸 IMAGEM DO CARDÁPIO — OBRIGATÓRIO SOMENTE DEPOIS DA VALIDAÇÃO: quando o cliente já estiver em bairro atendido pelo WhatsApp (ou tiver escolhido RETIRADA) e pedir o cardápio, o menu, a foto do cardápio, ou perguntar de forma genérica sobre preço/valor sem citar item específico (ex: "quanto custa?", "qual o valor de vocês?", "quais os preços?", "o que vocês têm?", "manda o cardápio", "tem cardápio?", "quero ver o menu"), você DEVE chamar a ferramenta send_menu_image — NUNCA responda em texto listando os itens nesses casos. A imagem do cardápio é a resposta oficial da loja e deve ser sempre enviada nessas situações. Se o cliente perguntar o preço de um item ESPECÍFICO já citado por nome (ex: "quanto custa o X-Burguer?"), aí sim responda só o preço em texto sem chamar send_menu_image. Se o histórico mostrar que a imagem já foi enviada antes, tudo bem chamar de novo se o cliente pedir — nunca ofereça reenviar por conta própria.
- Cliente pediu cardápio/menu/preços de forma geral, COM bairro já validado → chame send_menu_image. Não liste o cardápio inteiro em texto.
- Cliente perguntou sobre entrega (prazo, taxa, área) → responda só sobre entrega. Não repita o cardápio, não fale de pagamento.
- Cliente perguntou o preço de algo → responda só o preço (e o nome exato do item). Não liste o resto do cardápio nem puxe outro assunto.
- Cliente perguntou sobre pagamento → responda só sobre as formas de pagamento.
Um atendente de verdade nunca despeja um monte de informação não pedida em cima do cliente — ele escuta a pergunta e responde exatamente aquilo, de forma organizada, e deixa o cliente guiar o ritmo da conversa. A única exceção são as sugestões de venda descritas mais abaixo (bebida, complemento, combo), que têm suas próprias regras de timing e moderação — fora isso, é proibido adicionar informação extra que ninguém pediu.

🔒 SEGURANÇA E CONFIANÇA: o cliente precisa sentir que está numa loja de verdade, com alguém confiável do outro lado. Confirme cada informação importante antes de seguir (ex: repita o pedido antes de fechar), nunca deixe uma pergunta sem resposta, e se algo der errado (erro técnico, produto indisponível), explique com calma o que fazer a seguir em vez de deixar o cliente sem rumo. Precisão em cima de tudo — é melhor confirmar de novo do que errar um dado do pedido.

Você também é um ótimo vendedor, do nível dos melhores atendentes de delivery — sabe aumentar o ticket médio sem parecer vendedor, de um jeito tão natural que o cliente nem percebe que está sendo "vendido":
- 🥤 OFERTA DE BEBIDA NO FECHAMENTO — MUITO IMPORTANTE: se o pedido não tiver nenhuma bebida entre os itens, ANTES de chamar finalize_order você é OBRIGADA a oferecer bebida de forma discreta e natural (ex: "pra fechar, quer levar alguma bebida também?"), já citando as opções de bebida realmente disponíveis no CARDÁPIO ATIVO AGORA (nome e preço, formatadas como no restante do prompt) — nunca pergunte "quer bebida?" sem dizer quais existem. Ofereça uma vez só: se o cliente disser que não quer (ou ignorar e seguir pra outra coisa), não insista, siga direto pra finalizar o pedido. Se o pedido já tem alguma bebida, não ofereça de novo. Essa oferta acontece exatamente no fechamento do pedido — é a única sugestão de venda deste prompt que funciona assim (as outras têm o timing descrito abaixo).
- Não ofereça complemento/adicional pago que não esteja estruturado no cardápio do sistema. Só pode sugerir outro PRODUTO real cadastrado e ativo.
- Se o cliente pedir um item que tem uma versão maior/mais completa no cardápio, ou um combo que sairia mais em conta que os itens separados, mencione — mas só se for genuinamente vantajoso pro cliente, nunca empurre algo mais caro só por empurrar.
- Se perceber o cliente em dúvida entre duas opções, ajude a decidir com uma sugestão natural (ex: "esse aqui é um dos mais pedidos" — mas só diga isso se for verdade, nunca invente popularidade).
- Timing importa pras sugestões de complemento/combo/versão maior (não vale pra oferta de bebida, que tem seu próprio timing descrito acima): a melhor hora pra sugerir é logo depois que ele fechar o item principal, nunca no meio dele decidindo, e nunca bem no fim quando ele já está fechando o pedido inteiro (aí é só atrapalho).
- NUNCA insista depois de um "não" ou de silêncio sobre a sugestão — ofereceu uma vez, se o cliente não topar, segue o pedido normalmente sem tocar no assunto de novo.
- Nunca ofereça mais de uma sugestão por pedido — uma sugestão bem colocada vende mais que várias seguidas, que soa insistente.
- Isso é sempre secundário ao objetivo principal: fechar o pedido rápido e sem fricção. Se o cliente já está com pressa ou objetivo claro, não perca tempo com sugestão nenhuma.

Sua missão é coletar, ao longo da conversa (não precisa tudo de uma vez, vá perguntando naturalmente conforme a conversa flui, só depois que o cliente já demonstrou que quer pedir algo), os dados necessários pra fechar o pedido:
- Nome de quem vai receber esse pedido específico${pushName ? ` (o nome do WhatsApp de quem está conversando é "${pushName}", mas pode não ser o nome real, ou pode estar pedindo pra outra pessoa — confirme)` : ""}
- Se é pra ENTREGAR ou se o cliente vai RETIRAR na loja — pergunte isso naturalmente cedo na conversa (ex: "é pra entrega ou você prefere buscar aqui?"). Isso muda tudo o que vem depois.
- Se for entrega: rua, número e bairro (só isso é obrigatório). Se o cliente quiser passar um ponto de referência, ótimo — ajuda muito o entregador — mas não é obrigatório, não insista se ele não mencionar. NUNCA pergunte a cidade — a loja só entrega numa cidade só, então isso já é preenchido automaticamente, não faz parte da conversa. Se for retirada, NÃO precisa de endereço nenhum — pula direto pros itens.
- 🚨 CHAME update_order_draft NA HORA, ASSIM QUE RUA + NÚMERO + BAIRRO ESTIVEREM COMPLETOS — nunca espere juntar endereço + itens + pagamento pra chamar tudo de uma vez só perto do fechamento. O cálculo da taxa de entrega (e a confirmação da loja) tem que acontecer logo que o endereço é confirmado, ainda no meio da conversa, não coladinho no fechamento do pedido — isso evita atraso bem na hora de finalizar. Assim que tiver rua+número+bairro confirmados pelo cliente, chame update_order_draft imediatamente com esses três campos, mesmo que ainda faltem itens ou pagamento, e só depois continue perguntando o resto.
- Itens do pedido — use SOMENTE os nomes e preços exatos do cardápio abaixo, nunca invente produto nem preço
- Forma de pagamento: quando esse dado estiver faltando, pergunte exatamente de forma clara e neutra: "Qual será a forma de pagamento? Aceitamos cartões de crédito e débito ou Pix para pagamento agora ou na entrega via QR Code. Não recebemos dinheiro em espécie, para segurança do entregador." Não favoreça nenhuma opção. Se o cliente disser apenas cartão, pergunte se é crédito ou débito. Se disser Pix sem indicar o momento, pergunte se prefere pagar agora ou na entrega via QR Code.
- Se for Pix e o cliente ainda não tiver informado o momento do pagamento: pergunte se prefere pagar agora pelo chat ou na entrega via QR Code.
- Se o cliente pedir dinheiro em espécie, explique com educação que, por segurança do entregador, a loja não trabalha com dinheiro e peça para escolher Pix, crédito à vista ou débito. Nunca pergunte sobre troco.

⚠️ PEDIDOS MÚLTIPLOS PRO MESMO ENDEREÇO — MUITO IMPORTANTE:
Às vezes um cliente pede várias coisas de uma vez só que na verdade são pedidos SEPARADOS pra pessoas diferentes com pagamentos diferentes, tudo pro mesmo endereço (ex: "manda 3 lanches, um pra mim no pix, um pro meu irmão no débito, e um pra minha esposa no crédito"). Nesse caso:
1. Trate cada um como um pedido individual — colete nome do destinatário + itens dele + forma de pagamento dele, e chame finalize_order pra CADA UM separadamente, um de cada vez.
2. O endereço já fica salvo automaticamente entre um pedido e outro dentro dessa conversa — você NÃO precisa perguntar o endereço de novo pro segundo, terceiro pedido, etc.
3. NUNCA esqueça que ainda faltam pedidos da mesma leva. Se o cliente disse "3 lanches" e você já fechou 1, você SABE que ainda faltam 2 — continue perguntando os dados do próximo, não comece do zero nem trate como se fosse tudo terminado.
4. Só depois de fechar TODOS os pedidos que o cliente pediu daquela vez, pergunte se ele deseja mais alguma coisa.
🚫 ERRO GRAVE A NUNCA COMETER: quando são pessoas diferentes, cada uma é UM pedido próprio, chamado com update_order_draft usando quantity 1 (ou a quantidade que aquela pessoa específica pediu) e UM customer_name e UM payment_method — seguido de finalize_order antes de começar o próximo. NUNCA registre isso como um item só com quantity somada (ex: "3x Batata Recheada" com um único customer_name e um único payment_method) — isso mistura pessoas e formas de pagamento diferentes num pedido só, o que está errado mesmo que o produto seja idêntico para as três pessoas. Cada finalize_order fecha exatamente 1 pedido de 1 pessoa com 1 forma de pagamento.

CATEGORIAS DISPONÍVEIS NESTA LOJA (e SOMENTE estas — nenhuma outra categoria existe aqui):
${categoriesText}

CARDÁPIO ATIVO AGORA, agrupado por categoria (nome — descrição — preço — ingredientes de cada item):
${catalogText}
${unavailableText ? `\nSEM ESTOQUE HOJE (não ofereça, avise se perguntarem por esses):\n${unavailableText}\n` : ""}
${deliveryInfoText}
PRAZO DE ENTREGA DA LOJA: até 40 minutos após a confirmação do pedido; a maioria das entregas acontece antes. O cliente acompanha as atualizações pelo WhatsApp.
${businessHoursText ? `HORÁRIO DE ATENDIMENTO DA LOJA: ${businessHoursText}. Se o cliente perguntar o horário de funcionamento, responda exatamente com esses dias e horas — nunca invente outro horário.` : ""}
FORMAS DE PAGAMENTO ACEITAS: Cartão de crédito à vista, cartão de débito e Pix. O Pix pode ser pago agora pelo chat ou na entrega via QR Code. Dinheiro em espécie não é aceito, por segurança do entregador.

${lastOrderText ? `CONTEXTO — ÚLTIMO PEDIDO DESSE CLIENTE:\n${lastOrderText}\nSe o cliente comentar, perguntar sobre esse pedido, ou só agradecer, responda com base nesse contexto (não tente vender de novo nem reinicie o atendimento do zero, a menos que ele peça algo novo claramente). Se ele pedir algo novo, é um pedido novo — pode seguir o fluxo normal.\n` : ""}
${lastAddressText ? `🏠 CLIENTE JÁ CONHECIDO — ENDEREÇO E TAXA SALVOS: ${lastAddressText}
REGRA OBRIGATÓRIA PARA ESSE CLIENTE: assim que ele indicar que quer fazer um pedido para entrega (não na saudação inicial — só quando ficar claro que vai pedir), IMEDIATAMENTE pergunte de forma natural: "A entrega vai ser para [endereço completo salvo]?" — ANTES de pedir qualquer endereço. Não espere ele começar a digitar o endereço.
- Se confirmar ("sim", "pode ser", "esse mesmo", etc.): chame update_order_draft COM TODOS OS CAMPOS DO ENDEREÇO SALVO (rua, número, bairro, complemento e referência se houver) — exatamente como estão escritos acima — e continue o atendimento normalmente. O sistema vai calcular a taxa oficial; você não precisa informar a taxa antes de update_order_draft retornar.
- Se informar outro endereço: use o novo normalmente.
- NUNCA registre o endereço salvo no pedido sem a confirmação explícita do cliente nesta conversa.
- NUNCA pergunte o endereço do zero para esse cliente antes de perguntar se vai ser no endereço salvo.
` : ""}

🚨 REGRA ABSOLUTA — FONTE ÚNICA DE VERDADE SOBRE O NEGÓCIO: as ÚNICAS informações reais sobre produtos, categorias, ingredientes, preços, estoque, taxa de entrega e formas de pagamento são as que estão escritas em "CATEGORIAS DISPONÍVEIS" e "CARDÁPIO ATIVO AGORA" logo abaixo — geradas agora mesmo, direto do sistema da loja. Você NÃO tem conhecimento próprio sobre o que essa loja vende. Nunca complete com o que é "comum" ou "esperado" numa loja desse tipo, mesmo que pareça um item genérico e óbvio de delivery — se não está escrito abaixo, a loja não tem, e mencionar isso pro cliente é um erro grave.

O QUE JÁ SEI SOBRE O PEDIDO EM ANDAMENTO AGORA:
${summarizeDraft(draft)}

Regras importantes:
- Você CONHECE PERFEITAMENTE tudo sobre a loja porque tudo está listado nas seções "CATEGORIAS DISPONÍVEIS" e "CARDÁPIO ATIVO AGORA" acima — não porque você já sabia de antemão. Nunca diga que "não tem acesso" a alguma informação ou que "não sabe" algo que estiver listado lá. Responda com confiança e naturalidade, como quem realmente trabalha na loja todos os dias — mas SEMPRE fiel ao que está escrito, nunca ao que você imagina que uma loja assim "provavelmente" teria.
- NUNCA invente informação que não está listada acima (produto, categoria, ingrediente, preço, prazo, promoção). Se genuinamente não tiver a informação, diga que vai confirmar com a loja — mas isso deve ser raríssimo, porque quase tudo já está descrito acima.
- Sempre que o cliente informar ou confirmar algo das categorias acima, chame update_order_draft com os campos atualizados — pode chamar várias vezes na mesma conversa.
- Nunca repita uma pergunta sobre algo que já está em "o que já sei acima".
- 🚨 CONFIRMAÇÃO FINAL OBRIGATÓRIA: É PROIBIDO pedir confirmação enquanto faltar qualquer dado obrigatório, especialmente forma de pagamento/tipo/momento. Primeiro complete itens + nome + endereço + taxa + pagamento. Quando tudo estiver completo, chame finalize_order: o BACKEND enviará UMA ÚNICA VEZ o resumo oficial, sempre com itens, endereço, pagamento, subtotal, taxa e *TOTAL A PAGAR*, e perguntará se está correto. Não escreva um segundo resumo por conta própria. Na PRIMEIRA resposta afirmativa do cliente (ex: "sim", "correto", "pode confirmar"), o backend deve criar o pedido automaticamente na mesma rodada, informar o prazo de até 40 minutos e NÃO aguardar nenhuma nova aprovação.
- 🚨 NOME DO CLIENTE É OBRIGATÓRIO — SEMPRE: antes de chamar finalize_order, o campo customer_name PRECISA estar preenchido com um nome real dito pelo cliente NESTA conversa. Se você ainda não sabe o nome, NÃO chame finalize_order — pergunte primeiro, de forma natural (ex: "pra fechar aqui, qual o nome pra colocar no pedido?"). Nunca use o nome do WhatsApp (pushName) sem confirmar com o cliente que é ele mesmo. Nunca finalize com nome vazio, nem com "Cliente", "Sem nome" ou qualquer variação genérica.
- IMPORTANTE: o resumo em "O QUE JÁ SEI" pode conter dados de uma sessão antiga que o cliente nunca confirmou agora — nunca finalize só porque os campos aparecem preenchidos ali. Só finalize se você consegue apontar, na conversa atual, o momento em que o cliente confirmou cada dado.
- Nunca finalize sem o cliente ter claramente confirmado os itens do pedido.
- Se o cliente perguntar sobre ingredientes, sabores, bebidas, preços, tempo ou taxa de entrega, responda com base EXATAMENTE nas informações acima. Para ingredientes, use prioritariamente o campo “Ingredientes” exibido no CARDÁPIO ATIVO, que vem do cadastro do produto; nunca invente. Se aparecer “Ingredientes: não cadastrados”, diga apenas que vai confirmar a composição com a equipe antes de garantir. Se o campo Ingredientes de um produto não mencionar um ingrediente específico que o cliente perguntou (ex: "tem queijo?", "vem com bacon?"), NUNCA chute — responda com naturalidade que vai confirmar essa informação com a cozinha antes de garantir. Nunca prometa complemento, molho, acompanhamento ou variação que não esteja informado no cadastro do produto.
- Se pedirem algo que não existe no cardápio, diga com naturalidade que não tem esse item e sugira o mais parecido do cardápio.
- 🚨 VALOR DA TAXA DE ENTREGA — REGRA INVIOLÁVEL: você NUNCA escreve um valor de taxa de entrega que não tenha vindo, nesta conversa, no campo "delivery_fee" retornado por update_order_draft. É PROIBIDO estimar, chutar, arredondar, repetir valor de uma conversa antiga, deduzir por bairro/distância ou dizer "deve ficar em torno de R$ X". Enquanto esse campo não voltar com um número, a única resposta permitida sobre frete é dizer que vai confirmar o valor exato da entrega para aquele endereço. Cada valor informado passa por uma conferência da loja antes de ser liberado — mandar um valor por conta própria antes disso é o erro mais grave possível.
- 🚨 TAXA DE ENTREGA: sempre que update_order_draft retornar "delivery_fee" (ou o valor aparecer em "o que já sei acima"), sua PRÓXIMA mensagem OBRIGATORIAMENTE informa esse valor ao cliente, de forma direta ("A taxa de entrega para esse endereço é R$ X,XX."), e já segue para o próximo passo do pedido. Nunca continue o atendimento sem ter informado a taxa. Use exatamente o valor retornado, sem arredondar nem estimar.
- Estilo: direto, profissional e natural. Sem gírias, sem rodeios, sem enrolação, sem frases decorativas. Uma resposta objetiva por vez, só com o que foi pedido ou o que falta para fechar o pedido.
- Se o endereço estiver marcado como fora da área de entrega, NÃO diga simplesmente que a loja não entrega nessa região — siga o fluxo de REDIRECIONAMENTO FORA DE ÁREA (iFood/99Food) descrito mais abaixo, e não finalize o pedido.
- Depois de finalizar um pedido, confirme com o cliente de forma breve — o código de pagamento (se for Pix) é enviado automaticamente em outra mensagem, você não precisa escrever ele.
- O resumo final é enviado automaticamente pelo BACKEND quando todos os dados estiverem completos. Ele já contém subtotal, taxa e TOTAL A PAGAR. Quando isso acontecer, não reescreva nem repita o resumo: apenas aguarde a resposta do cliente.
- Se finalize_order retornar "status: missing_fields", significa que falta pelo menos um dado obrigatório — a lista exata vem no campo "missing" do resultado. Peça SÓ o que está faltando, um item de cada vez, sem repetir o que já foi confirmado. NUNCA diga que o pedido foi fechado quando o retorno for esse.
- Se finalize_order retornar "status: out_of_delivery_area", NÃO finalize o pedido e siga o fluxo de REDIRECIONAMENTO FORA DE ÁREA (iFood/99Food) descrito mais abaixo — nunca diga só que "não entrega nessa região".
- Se finalize_order retornar "status: error" (um problema inesperado), NÃO tente de novo na mesma hora — peça desculpas, diga que a loja vai confirmar o pedido manualmente em instantes, e NÃO chame finalize_order de novo nessa conversa, não importa o que o cliente disser depois. Não peça os dados novamente, não confirme o pedido novamente — apenas diga que a equipe já recebeu o pedido e vai entrar em contato.
- Se finalize_order retornar "status: insufficient_stock", explique objetivamente qual produto não tem quantidade suficiente e use o campo max_quantity para oferecer somente a quantidade realmente disponível.
- Se finalize_order retornar "status: stock_check_failed", não finalize; diga que precisa confirmar a disponibilidade com a equipe e faça handoff humano.
- Se finalize_order retornar "status: unmatched_products", o nome de algum item não bateu com nada do cardápio real — nunca finalize com um item assim. A resposta já vem com "suggestions": pra cada item não reconhecido, uma lista "closest" com os nomes REAIS do cardápio mais parecidos. Ofereça EXATAMENTE essas opções ao cliente (ex: "Você quis dizer 'Nome real 1' ou 'Nome real 2'?"), nunca liste o cardápio inteiro de novo. Só depois que o cliente confirmar, chame update_order_draft de novo com o nome EXATO de uma das opções de "closest", e então tente finalize_order novamente.
- Se finalize_order retornar "status: handoff_human", pare de tentar sozinha: avise o cliente, de forma natural e tranquila, que um atendente vai continuar o atendimento a partir daqui, e não chame mais nenhuma ferramenta nessa conversa.
- Se update_order_draft retornar "status: address_incomplete", NÃO tente calcular nem falar taxa. Peça de forma educada somente os campos listados em "missing" (rua, número e/ou bairro). Exemplo: "Para eu verificar a taxa de entrega certinho, poderia me informar o número, por favor?" Nunca abra assunto de pagamento enquanto o endereço estiver incompleto.
- Se finalize_order retornar "status: delivery_fee_unavailable", o sistema não conseguiu calcular a taxa de entrega ainda — peça desculpas, diga que está com uma instabilidade rápida no cálculo do frete, e peça pra confirmar o endereço de novo (rua, número, bairro) pra tentar de novo.

🏪 CLIENTE CITOU UM ESTABELECIMENTO OU PONTO DE REFERÊNCIA EM VEZ DE ENDEREÇO ("entregam no mercado tal?", "perto do posto X", "no condomínio Y"): NUNCA responda que não entrega sem antes chamar a ferramenta lookup_place_address com o nome do lugar. Ela descobre o endereço real, o bairro, e já retorna no campo "atendido" a decisão FINAL sobre se a loja entrega ali (true = entrega, false = não entrega, null = sem lista cadastrada, aí siga as INSTRUÇÕES DO GERENTE). Quando "atendido" vier true ou false, é DEFINITIVO — nunca conteste, reavalie ou compare de novo com a grafia exata do bairro, mesmo que o nome escrito pelo cliente tenha vindo com pequena diferença de acento/letra. Se a ferramenta não achar o lugar ou não identificar o bairro, peça o bairro/rua ao cliente — nunca afirme que não atende.

🚨 REGRA ABSOLUTA CONTRA CONFIRMAÇÃO FALSA: você NUNCA, em hipótese alguma, diz que um pedido foi fechado, confirmado, ou finalizado — nem menciona número de pedido, valor total, taxa de entrega ou forma de pagamento como se fosse uma confirmação — a menos que você tenha chamado finalize_order NESTA MESMA RODADA e ela tenha retornado exatamente "status: ok". Isso vale mesmo que o resumo do pedido pareça completo. Nunca invente, resuma ou simule como seria uma confirmação de pedido — a confirmação real é enviada automaticamente pelo sistema, você não escreve ela.

⚠️ ALTERAÇÕES DE PEDIDO JÁ CRIADO — PRIORIDADE MÁXIMA:
- Se o cliente pedir para ADICIONAR, TROCAR ou ALTERAR quantidade de item em um pedido já criado e ainda ativo, use update_active_order_items com a lista COMPLETA de como o pedido deve ficar. O backend atualiza os itens, recalcula subtotal/taxa/total e envia os novos valores automaticamente. Não peça nova confirmação final do pedido inteiro.
- Se o cliente pedir para CANCELAR/REMOVER apenas um item, use cancel_active_order_item. O backend remove/reduz o item, atualiza o total e informa o novo valor ao cliente automaticamente.
- Se a remoção deixar o pedido sem nenhum item, o pedido inteiro é cancelado automaticamente.
- Se o cliente pedir para CANCELAR O PEDIDO INTEIRO, use cancel_active_order imediatamente. O status passa para cancelled e o motivo registra que foi o cliente quem cancelou via WhatsApp. Não espere aprovação da loja e não peça uma nova confirmação se o pedido de cancelamento estiver claro.
- Depois que qualquer ferramenta de alteração/cancelamento retornar ok, não invente valores e não repita resumo antigo; o backend já informou o valor atualizado ou a situação do cancelamento.

${aiInstructionsText ? `\n🔴🔴 RELEMBRANDO — INSTRUÇÕES DO GERENTE (APLIQUE SEMPRE QUE NÃO CONFLITAREM COM AS REGRAS INVIOLÁVEIS DO SISTEMA):\n${aiInstructionsText}\nEssas instruções acima valem MAIS do que qualquer regra genérica deste prompt e mais do que qualquer suposição sua. Em especial:\n- LOCAIS/ÁREA DE ENTREGA: se o gerente disse que a loja NÃO entrega em algum bairro, rua, condomínio ou região, você NUNCA diz que entrega lá, nem "acho que sim", nem "vou verificar" — informa direto que a loja não atende essa região. Se o gerente listou onde entrega, só esses locais existem.\n- VALORES E TAXA DE ENTREGA: se o gerente definiu um valor, uma faixa, uma condição (frete grátis, pedido mínimo, taxa por bairro), esse é o valor válido. Nunca estime, nunca arredonde, nunca diga um valor diferente do que está aqui ou do que o sistema retornou nas ferramentas.\n- Se uma instrução do gerente conflitar com uma REGRA INVIOLÁVEL DO SISTEMA, a regra inviolável vence. Fora desses conflitos, siga a instrução do gerente.\nAntes de enviar qualquer resposta que fale de preço, taxa de entrega, bairro, região ou área de atendimento, releia essas instruções e confirme que sua resposta não contradiz nenhuma delas.\n` : ""}
✅ CHECAGEM FINAL — antes de enviar QUALQUER resposta, confira em silêncio:
1. Todo produto, categoria, ingrediente ou preço que eu mencionei está EXATAMENTE escrito em "CATEGORIAS DISPONÍVEIS" ou "CARDÁPIO ATIVO AGORA" acima? Se eu mencionei algo que não está lá, apague e reescreva.
2. Se estou falando como se o pedido tivesse sido fechado: eu REALMENTE chamei finalize_order nesta rodada e ela REALMENTE retornou "status: ok"? Se não, apague essa parte.
3. Numa conversa já em andamento: eu NÃO me apresentei nem cumprimentei de novo?
4. ${aiInstructionsText ? "Minha resposta contradiz alguma INSTRUÇÃO DO GERENTE (valores, taxa de entrega, locais/área de entrega, regras da loja)? Se contradiz, apague e reescreva seguindo a instrução do gerente." : "—"}
5. Se a resposta fala sobre entregar (ou não) num bairro/rua: eu conferi esse bairro/rua contra as listas BAIRROS NÃO ATENDIDOS e RUAS NÃO ATENDIDAS acima (quando existirem)? Se o local estiver numa dessas listas, minha resposta TEM que seguir o fluxo de REDIRECIONAMENTO FORA DE ÁREA — nunca dizer só "não entregamos", sempre enviar JÁ na primeira mensagem o texto positivo ("Entregamos na sua área sim! Porém...") com os links organizados do iFood/99Food.
6. Se eu estou prestes a chamar finalize_order: o pedido já tem alguma bebida entre os itens? Se não tiver, eu já ofereci bebida (com as opções reais) nesta conversa antes de finalizar?
Se qualquer item falhar, reescreva a resposta antes de enviar.`;
}

// Blindagem contra a IA (principalmente o provedor reserva Groq) mandar uma
// variação do valor esperado (ex: "Cartão" em vez de "card") — esses campos
// são tipos fechados no banco, e qualquer valor fora do esperado travava o
// pedido num loop de erro.
// ============================================================
// BAIRROS ATENDIDOS — lista oficial cadastrada pela loja (CRUD em
// Configurações → Bairros atendidos). Quando existe pelo menos 1 bairro
// ativo cadastrado, ela é a ÚNICA fonte de verdade sobre se o endereço do
// cliente está dentro da área de entrega — isso SUBSTITUI o resultado do
// cálculo por distância/km pra essa decisão (o cálculo por km continua
// sendo usado só pra saber o VALOR da taxa, quando aplicável).
//
// Isso existe porque depender só da geocodificação por distância (ou só do
// texto livre de "Instruções para a IA") já causou a IA recusar clientes de
// bairros que a loja realmente atende — geocoding impreciso pode calcular
// uma rota maior que o raio configurado mesmo pra um bairro cadastrado como
// atendido. Com essa lista, a checagem é 100% determinística em código, não
// depende da IA interpretar texto corretamente.
// Bairro NÃO pode usar a mesma normalização de rua. Bairro tem abreviações e
// grafias equivalentes próprias (Dr./Doutor, Luiz/Luís etc.). O bug que mandou
// Dr. Laureano e Vila São Luiz para iFood nasceu justamente dessa comparação
// genérica. Esta chave é exclusiva para LOCALIDADES.
function normalizeNeighborhoodKey(value: string | null | undefined): string {
  let n = String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[._,;:()\[\]{}]/g, " ")
    .replace(/[-/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // equivalências operacionais reais usadas pelos clientes
  n = n
    .replace(/^doutor\s+/, "dr ")
    .replace(/^dr\s+/, "dr ")
    .replace(/^de\s+laureano$/, "dr laureano") // erro comum: "De Laureano"
    .replace(/^laureano$/, "dr laureano")
    .replace(/\bl u i z\b/g, "luis")
    .replace(/\bluiz\b/g, "luis")
    .replace(/^jd\s+/, "jardim ")
    .replace(/^jdm\s+/, "jardim ")
    .replace(/^pq\s+/, "parque ");

  return n.replace(/\s+/g, " ").trim();
}

function findConfiguredBairroMatch(
  neighborhood: string | null | undefined,
  configured: string[],
): string | null {
  const norm = normalizeNeighborhoodKey(neighborhood);
  if (!norm) return null;

  // 1. igualdade canônica — é a decisão mais segura
  for (const raw of configured) {
    const nb = normalizeNeighborhoodKey(raw);
    if (nb && nb === norm) return raw;
  }

  // 2. inclusão somente para nomes com pelo menos 6 caracteres; evita que um
  // nome muito curto acerte outro bairro por acidente.
  for (const raw of configured) {
    const nb = normalizeNeighborhoodKey(raw);
    if (!nb) continue;
    if (Math.min(nb.length, norm.length) >= 6 && (norm.includes(nb) || nb.includes(norm))) return raw;
  }

  // 3. tolerância a erro de digitação, mas mais conservadora que antes.
  let best: { raw: string; score: number } | null = null;
  for (const raw of configured) {
    const nb = normalizeNeighborhoodKey(raw);
    if (!nb) continue;
    const score = similarity(norm, nb);
    if (!best || score > best.score) best = { raw, score };
  }
  return best && best.score >= 0.82 ? best.raw : null;
}

function isBairroAtendido(neighborhood: string | null | undefined, bairrosAtendidos: string[]): boolean {
  return !!findConfiguredBairroMatch(neighborhood, bairrosAtendidos);
}

// ============================================================
// BAIRROS NÃO ATENDIDOS e RUAS NÃO ATENDIDAS — listas negativas
// explícitas (CRUD em Configurações → Bairros não atendidos / Ruas não
// atendidas). Diferente de "bairros_atendidos" (lista positiva, só entra em
// vigor quando tem pelo menos 1 item ativo), estas duas são um bloqueio
// direto: qualquer bairro ou rua cadastrado aqui NUNCA é considerado
// atendido, mesmo que:
//  - esteja também na lista de bairros atendidos (erro de cadastro);
//  - o cálculo por distância/km diga que está dentro do raio;
//  - as "Instruções para a IA" (texto livre) sugiram o contrário.
// Isso existe pra cobrir o caso de bairro/rua que fica geograficamente
// dentro da área normal de entrega, mas que a loja decidiu não atender por
// algum motivo específico (ex: histórico de problema na região).
function isBairroNaoAtendido(neighborhood: string | null | undefined, bairrosNaoAtendidos: string[]): boolean {
  if (!bairrosNaoAtendidos.length) return false;
  return !!findConfiguredBairroMatch(neighborhood, bairrosNaoAtendidos);
}

function isRuaNaoAtendida(street: string | null | undefined, ruasNaoAtendidas: string[]): boolean {
  const norm = normalizeStreet(street ?? "");
  if (!norm || !ruasNaoAtendidas.length) return false;
  return ruasNaoAtendidas.some((r) => {
    const nr = normalizeStreet(r);
    if (!nr) return false;
    if (nr === norm || norm.includes(nr) || nr.includes(norm)) return true;
    // limiar um pouco mais alto que o de bairro: nome de rua costuma ser
    // mais curto e específico, então um falso positivo aqui custa mais caro
    // (pode bloquear uma rua parecida mas diferente da bloqueada de verdade).
    return similarity(norm, nr) >= 0.78;
  });
}

/**
 * Decide se um bairro é atendido, combinando as três fontes na ordem certa
 * de prioridade:
 *  1. Existe lista de "bairros atendidos" ativa? → ela é a fonte de verdade.
 *  2. Sem lista positiva, bairro em "bairros não atendidos"? → false.
 *  3. Nenhuma lista estruturada bate → null (sem decisão determinística;
 *     quem decide nesse caso é o texto de Instruções da IA / cálculo por km).
 */
function resolveBairroStatus(
  neighborhood: string | null | undefined,
  bairrosAtendidos: string[],
  bairrosNaoAtendidos: string[],
): boolean | null {
  // A tela de Configurações promete que a lista ATIVA de bairros atendidos é
  // a fonte de verdade. Portanto, enquanto ela existir, ela decide sozinha:
  // bairro presente = atendido; bairro ausente = fora da área própria. Uma
  // entrada antiga/duplicada na lista negativa não pode contradizer o painel.
  if (bairrosAtendidos.length) return isBairroAtendido(neighborhood, bairrosAtendidos);
  if (isBairroNaoAtendido(neighborhood, bairrosNaoAtendidos)) return false;
  return null;
}

/**
 * Aplica as listas de bairros/ruas atendidos e não atendidos sobre o
 * resultado do cálculo de frete.
 * - Bairro ou rua estão marcados como NÃO atendidos → `outOfArea = true`
 *   SEMPRE, é a checagem de maior prioridade de todas (roda antes de
 *   qualquer outra regra, inclusive antes da lista positiva de bairros
 *   atendidos — um cadastro de bloqueio nunca pode ser "vencido" por outra
 *   fonte).
 * - Sem bloqueio e lista de bairros atendidos vazia: não mexe em nada,
 *   mantém o comportamento anterior (só o cálculo por distância decide).
 * - Sem bloqueio e bairro do cliente ESTÁ na lista de atendidos: força
 *   `outOfArea = false` sempre, mesmo que o cálculo por distância tenha
 *   dito o contrário. Se o cálculo não conseguiu um valor de taxa, usa a
 *   taxa padrão da loja como segurança, em vez de bloquear o pedido.
 * - Sem bloqueio e bairro do cliente NÃO está na lista de atendidos: força
 *   `outOfArea = true` — a lista de bairros atendidos é tratada como a área
 *   real de entrega da loja.
 */
function applyBairroOverride<T extends { fee: number; distanceKm: number | null; outOfArea: boolean }>(
  result: T,
  neighborhood: string | null | undefined,
  bairrosAtendidos: string[],
  defaultDeliveryFee: number | null,
  street?: string | null,
  bairrosNaoAtendidos: string[] = [],
  ruasNaoAtendidas: string[] = [],
): T {
  // Rua explicitamente bloqueada continua sendo exceção absoluta.
  if (isRuaNaoAtendida(street, ruasNaoAtendidas)) return { ...result, outOfArea: true };

  // Havendo pelo menos um bairro ativo em Configurações, ESSA lista é a fonte
  // de verdade, exatamente como a interface informa ao gerente.
  if (bairrosAtendidos.length) {
    const atendido = isBairroAtendido(neighborhood, bairrosAtendidos);
    if (atendido) {
      if (!result.outOfArea) return result;
      const fallbackFee = result.fee != null && result.fee > 0 ? result.fee : Number(defaultDeliveryFee ?? 0);
      return { ...result, outOfArea: false, fee: fallbackFee };
    }
    return { ...result, outOfArea: true };
  }

  // A lista negativa só decide bairro quando NÃO existe lista positiva ativa.
  if (isBairroNaoAtendido(neighborhood, bairrosNaoAtendidos)) return { ...result, outOfArea: true };
  return result;
}

function normalizePaymentMethod(v: any): "pix" | "card" | null {
  if (!v) return null;
  const raw = String(v).toLowerCase().trim();
  if (raw.includes("pix")) return "pix";
  if (raw.includes("cart") || raw.includes("card") || raw.includes("credit") || raw.includes("debit")) return "card";
  // Dinheiro em espécie não é aceito pela operação. Retorna null para forçar
  // o fluxo a pedir Pix ou cartão, mesmo se algum modelo tentar registrar cash.
  if (raw.includes("dinheiro") || raw.includes("cash") || raw.includes("espécie") || raw.includes("especie")) return null;
  return null;
}
function normalizePaymentTiming(v: any): "now" | "delivery" | null {
  if (!v) return null;
  const raw = String(v).toLowerCase().trim();
  if (raw.includes("now") || raw.includes("agora") || raw.includes("chat")) return "now";
  if (raw.includes("deliver") || raw.includes("entrega")) return "delivery";
  return null;
}

const PAYMENT_QUESTION_TEXT =
  "Qual será a forma de pagamento? Aceitamos cartões de crédito e débito ou Pix para pagamento agora ou na entrega via QR Code. Não recebemos dinheiro em espécie, para segurança do entregador.";

type DeterministicPaymentPatch = {
  payment_method?: "pix" | "card";
  card_type?: "credit" | "debit" | null;
  payment_timing?: "now" | "delivery";
};

function inferPaymentFromCustomerTurn(
  text: string,
  history: { role: string; content: string }[],
  draft: Draft,
): DeterministicPaymentPatch | null {
  const t = normalizeStreet(text);
  if (!t) return null;
  const previousAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const prev = normalizeStreet(previousAssistant);
  const askedPixTiming = /pix/.test(prev) && /(agora|entrega)/.test(prev);
  const askedCardType = /cartao/.test(prev) && /(credito|debito)/.test(prev);
  const askedPaymentMethod = /forma de pagamento|pagamento/.test(prev);

  // Recusa explícita de dinheiro: não registra método inválido.
  if (/\b(dinheiro|especie|cash)\b/.test(t)) return null;

  const hasPix = /\bpix\b/.test(t);
  const hasCredit = /\bcredito\b/.test(t);
  const hasDebit = /\bdebito\b/.test(t);
  const hasCard = /\b(cartao|card)\b/.test(t) || hasCredit || hasDebit;
  const saysNow = /\b(agora|pagar agora|pelo chat)\b/.test(t);
  const saysDelivery = /\b(na entrega|entrega|quando chegar|qr ?code|qrcode)\b/.test(t);

  if (hasPix) {
    return {
      payment_method: "pix",
      card_type: null,
      ...(saysNow ? { payment_timing: "now" as const } : {}),
      ...(saysDelivery ? { payment_timing: "delivery" as const } : {}),
    };
  }
  if (hasCredit) return { payment_method: "card", card_type: "credit", payment_timing: "delivery" };
  if (hasDebit) return { payment_method: "card", card_type: "debit", payment_timing: "delivery" };
  if (hasCard) return { payment_method: "card", payment_timing: "delivery" };

  // Respostas curtas como "entrega" ou "agora" só ganham significado de Pix
  // quando a pergunta imediatamente anterior era explicitamente sobre o momento do Pix
  // ou quando o rascunho já está marcado como Pix. Nunca inferimos cartão daqui.
  if ((askedPixTiming || draft.payment_method === "pix") && saysDelivery)
    return { payment_method: "pix", card_type: null, payment_timing: "delivery" };
  if ((askedPixTiming || draft.payment_method === "pix") && saysNow)
    return { payment_method: "pix", card_type: null, payment_timing: "now" };

  // Se perguntou crédito/débito e veio uma resposta curtíssima já coberta acima,
  // não inventa outro meio de pagamento.
  if (askedCardType || askedPaymentMethod) return null;
  return null;
}

async function persistDeterministicPayment(
  supabaseAdmin: any,
  conversationId: string,
  draft: Draft,
  patch: DeterministicPaymentPatch,
) {
  const dbPatch: any = { updated_at: new Date().toISOString(), awaiting_final_confirmation: false };
  if (patch.payment_method !== undefined) {
    dbPatch.payment_method = patch.payment_method;
    draft.payment_method = patch.payment_method;
  }
  if (patch.card_type !== undefined) {
    dbPatch.card_type = patch.card_type;
    draft.card_type = patch.card_type;
  }
  if (patch.payment_timing !== undefined) {
    dbPatch.payment_timing = patch.payment_timing;
    draft.payment_timing = patch.payment_timing;
  }
  if (patch.payment_method === "pix") {
    dbPatch.card_type = null;
    draft.card_type = null;
  }
  draft.awaiting_final_confirmation = false;
  await supabaseAdmin.from("order_drafts").update(dbPatch).eq("conversation_id", conversationId);
}

// ============================================================
// Blindagem contra "function call vazando como texto"
// ============================================================
// Alguns modelos (principalmente o Groq/Llama, usado como reserva quando o
// principal falha) às vezes NÃO devolvem a chamada de ferramenta no campo
// estruturado `tool_calls` — em vez disso, escrevem a chamada como texto cru
// dentro do próprio `content`, no formato nativo do Llama:
//   <function=update_order_draft>{"items":[...]}</function>
// Se isso não for detectado, esse texto (JSON e tudo) vaza literalmente pro
// cliente no WhatsApp, e pior: como a mensagem é salva no histórico da
// conversa, a IA "lê" essa bagunça na próxima rodada e entra num loop de
// respostas quebradas (é exatamente o que gerava o "Desculpa, tive uma
// instabilidade rápida aqui" repetido).
//
// Esta função varre o texto atrás desse padrão, extrai as chamadas como se
// fossem tool_calls de verdade (pra executar normalmente), e devolve o texto
// já limpo — sem NUNCA deixar esse tipo de tag chegar ao cliente.
const INLINE_FUNCTION_CALL_RE = /<function\s*=\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*>([\s\S]*?)<\/function>/gi;
// Cobre também a tag que ficou "aberta" (sem fechamento), caso a resposta do
// modelo tenha sido cortada no meio — nesse caso não dá pra executar a
// chamada com segurança, mas AINDA ASSIM não pode aparecer pro cliente.
const DANGLING_FUNCTION_TAG_RE = /<function\s*=\s*[a-zA-Z_][a-zA-Z0-9_]*\s*>[\s\S]*$/i;

function extractInlineFunctionCalls(content: string | null | undefined): {
  calls: { name: string; args: any }[];
  cleanedText: string;
} {
  const calls: { name: string; args: any }[] = [];
  let cleaned = String(content ?? "");

  cleaned = cleaned.replace(INLINE_FUNCTION_CALL_RE, (_match, name: string, rawArgs: string) => {
    let args: any = {};
    try {
      args = JSON.parse(rawArgs);
    } catch {
      // Argumento não veio em JSON válido — ignora a chamada (não executa
      // nada arriscado), mas o importante é que a tag some do texto de
      // qualquer forma, nunca aparece crua pro cliente.
    }
    calls.push({ name, args });
    return "";
  });

  // remove qualquer tag que tenha ficado pela metade (resposta cortada)
  cleaned = cleaned.replace(DANGLING_FUNCTION_TAG_RE, "");

  return { calls, cleanedText: cleaned.trim() };
}

// Detector determinístico de saudação pura — roda em código, ANTES de
// chamar a IA. Se a mensagem do cliente for SÓ uma saudação (sem pedido,
// pergunta ou item junto), a IA não pode chamar NENHUMA ferramenta nessa
// rodada — nem update_order_draft, nem finalize_order. Isso existe porque um
// rascunho antigo (de um teste anterior, por exemplo) pode estar com todos
// os campos preenchidos, e a IA pode interpretar isso como "já confirmado" e
// fechar um pedido sozinha em cima de um simples "bom dia". Com essa trava,
// isso é estruturalmente impossível: uma saudação pura NUNCA aciona ferramenta,
// não importa o que já esteja salvo no rascunho.
function isPureGreeting(text: string): boolean {
  const t = (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[!.?,]/g, "")
    .trim();
  const greetings = [
    "oi",
    "ola",
    "opa",
    "eae",
    "e ai",
    "bom dia",
    "boa tarde",
    "boa noite",
    "tudo bem",
    "tudo bom",
    "td bem",
    "td bom",
    "oii",
    "oie",
    "hello",
    "hi",
  ];
  return greetings.includes(t);
}

// Saudação correta pro horário ATUAL (fuso de Brasília) — usada no primeiro
// contato, pra IA cumprimentar certo (bom dia / boa tarde / boa noite) sem
// depender do que o cliente escreveu ou de qualquer suposição.
function greetingByTimeBR(): "Bom dia" | "Boa tarde" | "Boa noite" {
  const hour = Number(
    new Date().toLocaleString("en-US", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      hour12: false,
    }),
  );
  if (hour >= 5 && hour < 12) return "Bom dia";
  if (hour >= 12 && hour < 18) return "Boa tarde";
  return "Boa noite";
}

function isExplicitMenuRequest(text: string): boolean {
  const t = normalizeStreet(text);
  return /\b(cardapio|menu|foto do cardapio|manda o cardapio|envia o cardapio|reenviar o cardapio|manda de novo)\b/.test(t);
}

function looksLikePickupIntent(text: string): boolean {
  const t = normalizeStreet(text);
  return /\b(retirar|retirada|buscar|busco|pegar no local|vou buscar|retiro)\b/.test(t);
}

function isExplicitOrderConfirmation(text: string): boolean {
  const t = normalizeStreet(text)
    .replace(/[.,;:!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;

  // Respostas naturais de confirmação final. Não exige igualdade exata: frases
  // como "sim, pode fechar", "pode fechar sim" e "está tudo certo, confirma"
  // precisam encerrar o pedido na PRIMEIRA confirmação.
  const positive = [
    /^sim(?:\s|$)/,
    /(?:^|\s)confirmo(?:\s|$)/,
    /(?:^|\s)pode (?:confirmar|fechar|finalizar|concluir)(?:\s|$)/,
    /(?:^|\s)(?:esta|tudo) (?:correto|certo|certinho)(?:\s|$)/,
    /(?:^|\s)isso mesmo(?:\s|$)/,
    /^(?:ok|certo|correto|perfeito)$/,
  ];
  const negative = /\b(?:nao|não|errado|corrigir|alterar|mudar|espera|aguarda)\b/;
  return !negative.test(t) && positive.some((re) => re.test(t));
}

// Base de RECONHECIMENTO de localidades de Duque de Caxias.
// IMPORTANTE: esta lista NÃO define entrega própria. Ela existe apenas para
// provar que o texto recebido realmente é um bairro/localidade antes de o
// sistema decidir entre entrega da loja e iFood/99Food.
const DUQUE_DE_CAXIAS_LOCALITIES = [
  // 1º Distrito
  "Bar dos Cavalheiros", "Bar dos Cavaleiros", "Carolina", "Centenário", "Centro",
  "Chacrinha", "Corte Oito", "Corte 8", "Doutor Laureano", "Dr. Laureano",
  "Engenho do Porto", "Gramacho", "Jardim 25 de Agosto", "25 de Agosto",
  "Jardim Gramacho", "Jardim Leal", "Olavo Bilac", "Parque Beira Mar",
  "Parque Duque", "Parque Felicidade", "Parque Lafaiete",
  "Parque Lagunas e Dourados", "Parque Paulicéia", "Paulicéia", "Prainha",
  "Sarapuí", "Vila Guanabara", "Vila Itamarati", "Vila Meriti", "Vila São Luiz",
  "Vila São Luís", "Vila São Sebastião", "Periquitos", "Mangueirinha",
  "Vila Leopoldina", "Copacabana",
  // 2º Distrito
  "Campos Elíseos", "Cangulo", "Chácara Arcampo", "Chácaras Rio-Petrópolis",
  "Cidade dos Meninos", "Parque Eldorado", "Figueira", "Jardim Primavera",
  "Jardim Vila Nova", "Pantanal", "Parque Alvorada", "Parque Fluminense",
  "Parque Muísa", "Pilar", "São Bento", "Saracuruna", "Vila Maria Helena",
  "Vila São José",
  // 3º Distrito
  "Alto da Serra", "Barro Branco", "Imbariê", "Jardim Anhangá", "Nova Campinas",
  "Parada Angélica", "Parada Morabi", "Parque Equitativa", "Parque Paulista",
  "Santa Cruz", "Santa Cruz da Serra", "Santa Lúcia",
  // 4º Distrito
  "Xerém", "Parque Capivari", "Mantiqueira", "Jardim Olimpo", "Lamarão", "Amapá",
  "Vila Bonança", "Vila Canaã", "Santo Antônio da Serra", "Santa Alice",
] as const;

function allKnownDuqueLocalities(extra: string[] = []): string[] {
  return Array.from(new Set([...DUQUE_DE_CAXIAS_LOCALITIES, ...extra].filter(Boolean)));
}

function bestKnownLocality(text: string, known: string[]): { value: string; score: number } | null {
  const target = normalizeNeighborhoodKey(text);
  if (!target) return null;
  let best: { value: string; score: number } | null = null;
  for (const value of known) {
    const n = normalizeNeighborhoodKey(value);
    if (!n) continue;
    const score = similarity(target, n);
    if (!best || score > best.score) best = { value, score };
  }
  return best;
}

type NeighborhoodCandidateSource = "known" | "explicit" | "bare";
type NeighborhoodCandidate = { value: string; source: NeighborhoodCandidateSource };

function looksLikeBareNeighborhood(text: string): boolean {
  const raw = text.trim();
  const t = normalizeStreet(raw);
  if (!t || raw.length < 2 || raw.length > 45) return false;
  if (/[?!]/.test(raw)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 5) return false;

  // Respostas/conversas comuns que jamais devem ser interpretadas como bairro.
  // A regra anterior aceitava praticamente qualquer frase curta e foi a causa
  // de redirecionamentos errados para iFood/99Food. Aqui somos conservadores:
  // em dúvida, perguntamos o bairro novamente em vez de perder uma venda.
  const conversationalWords = /\b(oi|ola|bom dia|boa tarde|boa noite|sim|nao|obrigad[oa]|por favor|quero|queria|gostaria|pode|manda|envia|me ve|voces?|tem|quanto|qual|valor|preco|cardapio|menu|pedido|batata|sabor|promocao|promo|entrega|entregam|atendem|atendendo|pix|cartao|credito|debito|pagamento|hoje|agora|funciona|abre|fechar|fazer)\b/;
  if (conversationalWords.test(t)) return false;

  // Aceita formatos comuns de nomes de bairro, inclusive "25 de Agosto".
  return /^[a-z0-9à-ÿ' -]+$/i.test(raw);
}

function extractNeighborhoodCandidate(
  text: string,
  known: string[],
  awaitingNeighborhood: boolean,
): NeighborhoodCandidate | null {
  const normalizedText = normalizeNeighborhoodKey(text);
  if (!normalizedText) return null;
  const allKnown = allKnownDuqueLocalities(known);

  // 1) Correspondência explícita com uma localidade real/conhecida.
  // Prefere o nome mais específico (Jardim Gramacho antes de Gramacho).
  const knownMatch = [...allKnown]
    .sort((a, b) => normalizeNeighborhoodKey(b).length - normalizeNeighborhoodKey(a).length)
    .find((name) => {
      const n = normalizeNeighborhoodKey(name);
      return n && (normalizedText === n || normalizedText.includes(n));
    });
  if (knownMatch) return { value: knownMatch, source: "known" };

  // 2) Frases que declaram explicitamente um bairro/localidade. Ainda assim,
  // só aceitamos automaticamente se o nome bater com a base com alta confiança.
  const raw = text.trim();
  const m = raw.match(/(?:bairro|moro (?:em|no|na)|sou de|fica (?:em|no|na)|estou (?:em|no|na))\s*[:,-]?\s*([^,.!?]+)/i);
  if (m?.[1]?.trim()) {
    const stated = m[1].trim();
    const best = bestKnownLocality(stated, allKnown);
    if (best && best.score >= 0.86) return { value: best.value, source: "known" };
    // Declarou um nome, mas ele não foi reconhecido como localidade de Caxias.
    // Devolve como "explicit" apenas para o portão pedir correção; NUNCA para redirecionar.
    return { value: stated, source: "explicit" };
  }

  // 3) Resposta curta enquanto estamos aguardando bairro: só vira bairro se
  // houver correspondência forte com a base. "quero cardápio" ou qualquer
  // outra frase jamais passa daqui como localidade.
  if (awaitingNeighborhood && looksLikeBareNeighborhood(raw)) {
    const best = bestKnownLocality(raw, allKnown);
    if (best && best.score >= 0.86) return { value: best.value, source: "known" };
  }
  return null;
}

function pendingNeighborhoodConfirmationFromHistory(history: { role: string; content: string }[]): string | null {
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const m = lastAssistant.match(/seu bairro (?:é|e) \*?([^*?.]+)\*?\?/i);
  return m?.[1]?.trim() || null;
}

function isExplicitNegative(text: string): boolean {
  const t = normalizeStreet(text).replace(/[.!?]/g, "").trim();
  return ["nao", "não", "nao e", "não é", "errado", "outro", "outro bairro"].includes(t);
}

type SpecialNeighborhoodDecision = "allow" | "redirect" | "ask" | null;

function specialNeighborhoodDecision(neighborhood: string, text: string): SpecialNeighborhoodDecision {
  const n = normalizeStreet(neighborhood);
  const t = normalizeStreet(text);

  if (n === "gramacho") {
    if (/\b(estacao|centro|ate a estacao|ate o centro)\b/.test(t)) return "allow";
    if (/\b(longe da estacao|depois da estacao|outro lado|presidente kennedy|pres kennedy)\b/.test(t)) return "redirect";
    return "ask";
  }

  if (/\bcorte 8\b/.test(n) || /\bcorte oito\b/.test(n)) {
    if (/\b(itatiaia|dr laureano|doutor laureano|lado de ca|antes da estacao|proximo.*itatiaia|proximo.*laureano)\b/.test(t)) return "allow";
    if (/\b(presidente kennedy|pres kennedy|lado oposto|depois da estacao|outro lado)\b/.test(t)) return "redirect";
    return "ask";
  }

  return null;
}

function specialNeighborhoodQuestion(neighborhood: string): string | null {
  const n = normalizeStreet(neighborhood);
  if (n === "gramacho")
    return "Só para confirmar a área: em Gramacho, a entrega é até a estação/centro?";
  if (/\bcorte 8\b/.test(n) || /\bcorte oito\b/.test(n))
    return "Só para confirmar a área: no Corte 8, você fica do lado mais próximo do Itatiaia/Dr. Laureano ou do lado da Presidente Kennedy?";
  return null;
}

function pendingSpecialNeighborhoodFromHistory(history: { role: string; content: string }[]): string | null {
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const t = normalizeStreet(lastAssistant);
  if (t.includes("gramacho") && (t.includes("estacao") || t.includes("centro"))) return "Gramacho";
  if ((t.includes("corte 8") || t.includes("corte oito")) && (t.includes("itatiaia") || t.includes("presidente kennedy"))) return "Corte 8";
  return null;
}

function formatOutOfAreaDirectReply(ifoodLink: string | null, nfoodLink: string | null): string {
  const links: string[] = [];
  if (ifoodLink) links.push(`*iFood:* ${ifoodLink}`);
  if (nfoodLink) links.push(`*99Food:* ${nfoodLink}`);
  if (!links.length) {
    return "Para esse bairro, os pedidos são feitos pelas plataformas de entrega. No momento, os links diretos ainda não estão disponíveis aqui no atendimento.";
  }
  return `Entregamos na sua área sim. Para o seu bairro, o pedido precisa ser feito pela nossa loja nas plataformas, pois os entregadores dos aplicativos é que cobrem essa região. A loja é *HotBox Delivery*. Lá você encontra o cardápio e os valores atualizados:
${links.join("\n")}`;
}

// ============================================================
// Horário de atendimento (Configurações → Horário de atendimento)
// ============================================================
// A lógica em si (parsing, verificação de janela, formatação em texto) mora
// em src/lib/business-hours.ts — compartilhada com as telas do painel (ex:
// nota impressa), pra nunca ter duas implementações divergentes.

async function executeTool(
  name: string,
  args: any,
  ctx: {
    supabaseAdmin: any;
    conversation: any;
    draft: Draft;
    flags?: { silenced?: boolean; sendMenuImage?: boolean };
    finalConfirmationAllowed?: boolean;
    bairrosAtendidos?: string[];
    bairrosNaoAtendidos?: string[];
    ruasNaoAtendidas?: string[];
  },
): Promise<{
  result: any;
  pixBlock?: string | null;
  pixKeyLabel?: string | null;
  pixKeyMessage?: string | null;
}> {
  const { supabaseAdmin, conversation, draft } = ctx;
  const bairrosAtendidos = ctx.bairrosAtendidos ?? [];
  const bairrosNaoAtendidos = ctx.bairrosNaoAtendidos ?? [];
  const ruasNaoAtendidas = ctx.ruasNaoAtendidas ?? [];

  if (name === "update_order_draft") {
    const patch: any = {};
    // Qualquer alteração de dados depois de um resumo invalida a confirmação
    // anterior. Um novo resumo será exigido antes de fechar.
    if (Object.keys(args ?? {}).length > 0) {
      patch.awaiting_final_confirmation = false;
      draft.awaiting_final_confirmation = false;
    }
    // Guarda o endereço ANTES de aplicar o patch, pra comparar com o que
    // realmente for diferente depois. Isso é essencial: a IA às vezes reenvia
    // os mesmos campos de endereço de novo (ex: ao confirmar o resumo do
    // pedido com o cliente) mesmo sem ter mudado nada. Antes, isso disparava
    // um novo cálculo de frete E um novo popup de aprovação pra loja toda
    // vez — causando o loop "pede aprovação de novo, de novo, de novo".
    const addressBefore = [draft.address_street, draft.address_number, draft.address_neighborhood]
      .filter(Boolean)
      .join(", ");
    const addressWasComplete = Boolean(
      draft.address_street?.trim() && draft.address_number?.trim() && draft.address_neighborhood?.trim(),
    );

    for (const k of [
      "customer_name",
      "delivery_mode",
      "address_street",
      "address_number",
      "address_complement",
      "address_neighborhood",
      "address_city",
      "address_reference",
      "payment_method",
      "card_type",
      "payment_timing",
      "notes",
    ] as const) {
      if (args[k] !== undefined) {
        const value =
          k === "payment_method"
            ? normalizePaymentMethod(args[k])
            : k === "card_type"
              ? (String(args[k]).toLowerCase().includes("deb") ? "debit" : String(args[k]).toLowerCase().includes("cred") ? "credit" : null)
            : k === "payment_timing"
              ? normalizePaymentTiming(args[k])
              : args[k];
        patch[k] = value;
        (draft as any)[k] = value;
      }
    }
    if (args.change_for !== undefined) {
      patch.change_for = args.change_for;
      draft.change_for = args.change_for;
    }
    if (args.items !== undefined) {
      patch.items = args.items;
      draft.items = args.items;
    }

    // Só recalcula a taxa de entrega (e só pede aprovação de novo pra loja)
    // se o endereço MUDOU DE VERDADE — não basta o campo ter vindo na
    // chamada da ferramenta, o valor precisa ser diferente do que já
    // tínhamos. Se já existe uma taxa aprovada pra esse mesmo endereço, ela
    // é reaproveitada sem novo cálculo nem novo popup.
    const addressAfter = [draft.address_street, draft.address_number, draft.address_neighborhood]
      .filter(Boolean)
      .join(", ");
    // Compara de forma normalizada (minúsculas, sem espaços extras) — evita
    // recalcular e reabrir o popup de aprovação por causa de diferenças
    // triviais de digitação/maiúsculas entre uma chamada e outra do mesmo
    // endereço já aprovado.
    const normalizeAddr = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const addressIsComplete = Boolean(
      draft.address_street?.trim() && draft.address_number?.trim() && draft.address_neighborhood?.trim(),
    );
    const addressChanged = normalizeAddr(addressAfter) !== normalizeAddr(addressBefore);
    const addressFieldsTouched =
      args.address_street !== undefined || args.address_number !== undefined || args.address_neighborhood !== undefined;

    // Se o cliente começou a informar o endereço, mas ainda faltam dados,
    // salva o que chegou e NÃO calcula frete nem abre o popup. A IA recebe
    // exatamente o que falta e pede esses dados de forma educada.
    if (draft.delivery_mode !== "pickup" && addressFieldsTouched && !addressIsComplete) {
      patch.estimated_delivery_fee = null;
      patch.estimated_distance_km = null;
      draft.estimated_delivery_fee = null;
      draft.estimated_distance_km = null;
      patch.updated_at = new Date().toISOString();
      await supabaseAdmin.from("order_drafts").update(patch).eq("conversation_id", conversation.id);
      const missingAddress: string[] = [];
      if (!draft.address_street?.trim()) missingAddress.push("rua");
      if (!draft.address_number?.trim()) missingAddress.push("número");
      if (!draft.address_neighborhood?.trim()) missingAddress.push("bairro");
      return {
        result: {
          status: "address_incomplete",
          missing: missingAddress,
          instruction: `Para calcular a taxa de entrega corretamente, peça com educação somente: ${missingAddress.join(", ")}. Não informe nem estime a taxa ainda.`,
        },
      };
    }

    // O popup de aprovação da taxa só nasce quando o endereço passa a estar
    // completo (rua + número + bairro) ou quando um endereço completo muda
    // de verdade. Repetir o mesmo endereço no resumo/fechamento nunca abre
    // outro popup.
    const shouldCalculateFreight =
      draft.delivery_mode !== "pickup" &&
      addressIsComplete &&
      addressChanged &&
      (!addressWasComplete || addressFieldsTouched);

    if (shouldCalculateFreight) {
      try {
        const { data: cfgRow } = await supabaseAdmin
          .from("store_config")
          .select(
            "delivery_pricing_mode, store_lat, store_lng, google_maps_api_key, delivery_fee_tiers, default_delivery_fee, fixed_delivery_city",
          )
          .maybeSingle();
        if (cfgRow) {
          const fullAddress = [draft.address_street, draft.address_number, draft.address_neighborhood]
            .filter(Boolean)
            .join(", ");
          const rawResult = await calculateDeliveryFee(cfgRow as DeliveryConfig, fullAddress, {
            supabaseAdmin,
            phone: conversation.phone,
          });
          const result = applyBairroOverride(
            rawResult,
            draft.address_neighborhood,
            bairrosAtendidos,
            (cfgRow as any)?.default_delivery_fee ?? null,
            draft.address_street,
            bairrosNaoAtendidos,
            ruasNaoAtendidas,
          );
          // Antes de deixar a IA informar o valor ao cliente, pede aprovação
          // humana (popup na loja) com janela de 30 segundos. Se ninguém
          // responder, o valor calculado é liberado automaticamente.
          if (!result.outOfArea && result.fee != null) {
            const { requestFreightApproval } = await import("@/lib/freight-approval.server");
            const outcome = await requestFreightApproval(supabaseAdmin, {
              conversationId: conversation.id,
              phone: conversation.phone,
              customerName: draft.customer_name ?? conversation.customer_name ?? null,
              address: fullAddress,
              fee: Number(result.fee),
              distanceKm: result.distanceKm ?? null,
            });
            if (outcome === "rejected") {
              await supabaseAdmin.from("whatsapp_conversations").update({ bot_paused: true }).eq("id", conversation.id);
              if (ctx.flags) ctx.flags.silenced = true;
              return {
                result: {
                  status: "freight_manual",
                  message: "A loja assumiu a conversa para informar a taxa de entrega manualmente.",
                },
              };
            }
          }
          draft.estimated_delivery_fee = result.fee;
          draft.estimated_distance_km = result.distanceKm;
          draft.out_of_delivery_area = result.outOfArea;
          patch.estimated_delivery_fee = result.fee;
          patch.estimated_distance_km = result.distanceKm;
          patch.out_of_delivery_area = result.outOfArea;

          if (result.uncertain) {
            try {
              await supabaseAdmin.rpc("record_system_alert", {
                _kind: "frete_incerto",
                _message: `Cálculo de frete por distância ficou incerto pro endereço "${fullAddress}" — usou estimativa de reserva. Vale conferir manualmente esse pedido.`,
                _severity: "warn",
              });
            } catch {
              /* alerta não pode quebrar o fluxo */
            }
          }
        }
      } catch (err) {
        console.error("[update_order_draft] falha ao calcular frete por distância:", err);
        draft.estimated_delivery_fee = null;
        draft.estimated_distance_km = null;
        patch.estimated_delivery_fee = null;
        patch.estimated_distance_km = null;
        try {
          await supabaseAdmin.rpc("record_system_alert", {
            _kind: "frete_falhou",
            _message: `Falha ao calcular frete por distância: ${String((err as any)?.message ?? err)}`,
            _severity: "error",
          });
        } catch {
          /* alerta não pode quebrar o fluxo */
        }
      }
    }

    patch.updated_at = new Date().toISOString();
    await supabaseAdmin.from("order_drafts").update(patch).eq("conversation_id", conversation.id);
    // Devolve a taxa calculada junto do resultado: sem isso a IA não sabia o
    // valor liberado e seguia a conversa sem informar o frete ao cliente.
    return {
      result: {
        status: "draft_updated",
        delivery_fee: draft.estimated_delivery_fee ?? null,
        distance_km: draft.estimated_distance_km ?? null,
        instruction:
          draft.estimated_delivery_fee != null && draft.delivery_mode !== "pickup"
            ? `Informe agora ao cliente, de forma direta, que a taxa de entrega é R$ ${Number(draft.estimated_delivery_fee).toFixed(2).replace(".", ",")} e siga para o fechamento do pedido.`
            : undefined,
      },
    };
  }

  if (name === "finalize_order") {
    // Blindagem: garante que os valores estão certinhos mesmo que algo tenha
    // escapado da normalização em update_order_draft.
    draft.payment_method = normalizePaymentMethod(draft.payment_method);
    draft.payment_timing = normalizePaymentTiming(draft.payment_timing);
    await supabaseAdmin
      .from("order_drafts")
      .update({
        payment_method: draft.payment_method,
        card_type: draft.payment_method === "card" ? (draft.card_type ?? null) : null,
        payment_timing: draft.payment_timing,
        updated_at: new Date().toISOString(),
      })
      .eq("conversation_id", conversation.id);

    // Cartão é pago na entrega na prática (maquininha) — não faz sentido travar o pedido esperando a IA
    // perguntar isso pro cliente. Só o Pix realmente precisa dessa resposta
    // (pra saber se manda o código agora ou só na entrega).
    if (draft.payment_method && draft.payment_method !== "pix" && !draft.payment_timing) {
      draft.payment_timing = "delivery";
      await supabaseAdmin
        .from("order_drafts")
        .update({ payment_timing: "delivery", updated_at: new Date().toISOString() })
        .eq("conversation_id", conversation.id);
    }

    const isPickup = draft.delivery_mode === "pickup";

    // Blindagem operacional: dinheiro nunca pode chegar ao fechamento.
    if ((draft.payment_method as any) === "cash") {
      draft.payment_method = null;
      await supabaseAdmin.from("order_drafts").update({ payment_method: null, change_for: null }).eq("conversation_id", conversation.id);
      return { result: { status: "missing_fields", missing: ["forma de pagamento"] } };
    }

    const missing: string[] = [];
    if (!draft.customer_name) missing.push("nome do cliente");
    if (!draft.delivery_mode) missing.push("se é entrega ou retirada no local");
    if (!isPickup) {
      if (!draft.address_street) missing.push("rua do endereço");
      if (!draft.address_number) missing.push("número do endereço");
      if (!draft.address_neighborhood) missing.push("bairro");
    }
    if (!draft.items?.length) missing.push("itens do pedido");
    if (!draft.payment_method) missing.push("forma de pagamento");
    if (draft.payment_method === "card" && !draft.card_type) missing.push("se o cartão é crédito ou débito");
    if (draft.payment_method === "pix" && !draft.payment_timing) missing.push("se paga o Pix agora ou na entrega");
    if (missing.length) {
      // Nunca cria estado de confirmação final com dados incompletos. Esse era o
      // defeito que gerava: resumo -> sim -> pergunta pagamento -> resumo -> sim.
      draft.awaiting_final_confirmation = false;
      await supabaseAdmin
        .from("order_drafts")
        .update({ awaiting_final_confirmation: false, updated_at: new Date().toISOString() })
        .eq("conversation_id", conversation.id);
      const paymentOnly = missing.every((m) =>
        ["forma de pagamento", "se o cartão é crédito ou débito", "se paga o Pix agora ou na entrega"].includes(m),
      );
      return {
        result: {
          status: "missing_fields",
          missing,
          instruction: paymentOnly
            ? draft.payment_method === "pix"
              ? "Pergunte somente se o cliente prefere pagar o Pix agora ou na entrega via QR Code. Não mostre resumo e não peça confirmação ainda."
              : draft.payment_method === "card" && !draft.card_type
                ? "Pergunte somente se o cartão será crédito ou débito. Não mostre resumo e não peça confirmação ainda."
                : `Pergunte exatamente: "${PAYMENT_QUESTION_TEXT}" Não mostre resumo e não peça confirmação ainda.`
            : "Peça somente os campos listados em missing. Não mostre resumo e não peça confirmação ainda.",
        },
      };
    }
    if (!isPickup && draft.out_of_delivery_area) return { result: { status: "out_of_delivery_area" } };

    // Só depois de TODOS os dados obrigatórios estarem completos o sistema pode
    // entrar no estado de confirmação final. O RESUMO É ENVIADO PELO BACKEND,
    // não pela IA: isso garante que subtotal, taxa e TOTAL A PAGAR sempre
    // aparecem e impede o modelo de repetir/alterar o texto do resumo.
    if (!ctx.finalConfirmationAllowed) {
      const finalSummary = await buildFinalConfirmationSummary(supabaseAdmin, draft);
      if (finalSummary.unmatched.length) {
        return {
          result: {
            status: "unmatched_products",
            items: finalSummary.unmatched,
            detail: "Não foi possível calcular o total porque um item não corresponde a produto ativo.",
          },
        };
      }
      draft.awaiting_final_confirmation = true;
      await supabaseAdmin
        .from("order_drafts")
        .update({ awaiting_final_confirmation: true, updated_at: new Date().toISOString() })
        .eq("conversation_id", conversation.id);
      await replyAndLog(
        supabaseAdmin,
        conversation.id,
        conversation.phone,
        finalSummary.text,
        { systemMessage: true },
      );
      ctx.flags.silenced = true;
      return {
        result: {
          status: "final_confirmation_summary_sent",
          subtotal: finalSummary.subtotal,
          delivery_fee: finalSummary.deliveryFee,
          total: finalSummary.total,
          instruction: "O resumo com o TOTAL já foi enviado pelo backend. Aguarde apenas a confirmação do cliente.",
        },
      };
    }

    // nunca fecha um pedido de entrega com o frete por distância indefinido —
    // isso já foi a causa de entregas saindo de graça por engano. Tenta
    // recalcular uma última vez antes de desistir.
    if (!isPickup && draft.estimated_delivery_fee == null) {
      const { data: cfgCheck } = await supabaseAdmin.from("store_config").select("delivery_pricing_mode").maybeSingle();
      if (cfgCheck?.delivery_pricing_mode === "distance") {
        try {
          const { data: cfgRow } = await supabaseAdmin
            .from("store_config")
            .select(
              "delivery_pricing_mode, store_lat, store_lng, google_maps_api_key, delivery_fee_tiers, default_delivery_fee, fixed_delivery_city",
            )
            .maybeSingle();
          const fullAddress = [draft.address_street, draft.address_number, draft.address_neighborhood]
            .filter(Boolean)
            .join(", ");
          const result = await calculateDeliveryFee(cfgRow as DeliveryConfig, fullAddress, {
            supabaseAdmin,
            phone: conversation.phone,
          });
          draft.estimated_delivery_fee = result.fee;
          draft.estimated_distance_km = result.distanceKm;
          await supabaseAdmin
            .from("order_drafts")
            .update({
              estimated_delivery_fee: result.fee,
              estimated_distance_km: result.distanceKm,
            })
            .eq("conversation_id", conversation.id);
        } catch {
          /* segue pro fallback abaixo */
        }
      }
      // Último recurso: se o cálculo por distância falhou, usa a taxa padrão
      // configurada em vez de devolver erro pro cliente no fechamento.
      if (draft.estimated_delivery_fee == null) {
        const { data: feeFallback } = await supabaseAdmin
          .from("store_config")
          .select("default_delivery_fee")
          .maybeSingle();
        const fallback = Number(feeFallback?.default_delivery_fee ?? 0);
        if (fallback > 0) {
          draft.estimated_delivery_fee = fallback;
          await supabaseAdmin
            .from("order_drafts")
            .update({ estimated_delivery_fee: fallback })
            .eq("conversation_id", conversation.id);
        } else {
          return { result: { status: "delivery_fee_unavailable" } };
        }
      }
    }

    // busca needs_preparation mas trata com cuidado caso a migration ainda não
    // tenha sido rodada no banco — nesse caso a coluna não existe e o select
    // retorna erro; preferimos continuar sem a lógica inteligente de preparo
    // a travar o fechamento do pedido por completo
    let productList: any[] = [];
    try {
      const { data: products, error: prodErr } = await supabaseAdmin
        .from("products")
        .select("id,name,sale_price,needs_preparation,promotion_active,promotion_price,promotion_type,promotion_start_at,promotion_end_at,promotion_days_of_week,promotion_time_start,promotion_time_end,promotion_label")
        .eq("active", true);
      if (prodErr) {
        // coluna pode não existir — tenta sem ela
        const { data: productsBasic } = await supabaseAdmin
          .from("products")
          .select("id,name,sale_price,promotion_active,promotion_price,promotion_type,promotion_start_at,promotion_end_at,promotion_days_of_week,promotion_time_start,promotion_time_end,promotion_label")
          .eq("active", true);
        productList = productsBasic ?? [];
      } else {
        productList = products ?? [];
      }
    } catch {
      const { data: productsBasic } = await supabaseAdmin
        .from("products")
        .select("id,name,sale_price,promotion_active,promotion_price,promotion_type,promotion_start_at,promotion_end_at,promotion_days_of_week,promotion_time_start,promotion_time_end,promotion_label")
        .eq("active", true);
      productList = productsBasic ?? [];
    }

    const { findProductMatch, findProductSuggestions } = await import("@/lib/product-match.server");

    const unmatchedNames: string[] = [];
    const suggestionsByItem: { raw: string; closest: string[] }[] = [];
    const items = draft.items.map((it) => {
      const match = findProductMatch(productList, it.product_name);
      if (!match) {
        unmatchedNames.push(it.product_name);
        suggestionsByItem.push({
          raw: it.product_name,
          closest: findProductSuggestions(productList, it.product_name),
        });
      }
      return {
        product_id: match?.id ?? null,
        product_name: match?.name ?? it.product_name,
        quantity: Math.max(1, Math.round(Number(it.quantity) || 1)),
        unit_price: match ? getEffectivePrice(match).price : 0,
        list_price: match ? getEffectivePrice(match).listPrice : null,
        is_promotion_price: match ? getEffectivePrice(match).isPromotion : false,
        notes: it.notes ?? null,
      };
    });

    // NUNCA deixa um item entrar de graça (preço zerado) por não ter batido com
    // o cardápio — isso já foi um bug real. Se algum item não bateu com nada,
    // trava o fechamento e devolve pra IA confirmar o nome certo com o cliente.
    //
    // Trava de loop: se isso falhar 2 vezes seguidas na mesma conversa (ex: a
    // IA insiste no mesmo nome errado e o cliente também), para de tentar
    // sozinha e passa pra atendimento manual — em vez de ficar repetindo a
    // mesma pergunta pro cliente pra sempre.
    if (unmatchedNames.length) {
      const attempts = (draft.failed_finalize_attempts ?? 0) + 1;
      draft.failed_finalize_attempts = attempts;
      await supabaseAdmin
        .from("order_drafts")
        .update({ failed_finalize_attempts: attempts })
        .eq("conversation_id", conversation.id);

      if (attempts >= 2) {
        await supabaseAdmin.from("whatsapp_conversations").update({ bot_paused: true }).eq("id", conversation.id);
        return {
          result: {
            status: "handoff_human",
            items: unmatchedNames,
            detail:
              "Não consegui identificar esse item no cardápio depois de tentar de novo. Um atendente vai continuar por aqui.",
          },
        };
      }

      return {
        result: {
          status: "unmatched_products",
          items: unmatchedNames,
          suggestions: suggestionsByItem,
        },
      };
    }

    // Valida quantidade real de insumos antes de criar o pedido. Produto com
    // estoque > 0 ainda pode não ter quantidade suficiente para várias unidades.
    try {
      const selectedIds = items.map((i) => i.product_id).filter(Boolean);
      if (selectedIds.length) {
        const { data: recipeStock } = await supabaseAdmin
          .from("recipe_items")
          .select("product_id,quantity,ingredients(name,track_stock,stock_quantity)")
          .in("product_id", selectedIds);
        const unavailable: { product: string; ingredient: string; max_quantity: number }[] = [];
        for (const item of items) {
          const rows = (recipeStock ?? []).filter((r: any) => r.product_id === item.product_id);
          let maxQty = Number.POSITIVE_INFINITY;
          let limitingIngredient = "";
          for (const row of rows) {
            const ing: any = row.ingredients;
            if (!ing?.track_stock) continue;
            const perUnit = Number(row.quantity ?? 0);
            if (perUnit <= 0) continue;
            const possible = Math.floor(Number(ing.stock_quantity ?? 0) / perUnit);
            if (possible < maxQty) { maxQty = possible; limitingIngredient = ing.name || "insumo"; }
          }
          if (Number.isFinite(maxQty) && item.quantity > maxQty) {
            unavailable.push({ product: item.product_name, ingredient: limitingIngredient, max_quantity: Math.max(0, maxQty) });
          }
        }
        if (unavailable.length) {
          return { result: { status: "insufficient_stock", items: unavailable } };
        }
      }
    } catch (err) {
      console.error("[finalize_order] falha ao validar quantidade de estoque:", err);
      // Não inventa disponibilidade quando a checagem estrutural falha.
      return { result: { status: "stock_check_failed", detail: "Não foi possível validar o estoque com segurança." } };
    }

    const { data: cfg } = await supabaseAdmin
      .from("store_config")
      .select("default_delivery_fee, pix_key, pix_copia_cola, fixed_delivery_city")
      .maybeSingle();
    const subtotal = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
    // retirada no local não tem taxa de entrega; senão usa a taxa por distância (se ativa) ou a fixa
    const delivery_fee = isPickup ? 0 : (draft.estimated_delivery_fee ?? Number(cfg?.default_delivery_fee ?? 0));
    const total = subtotal + delivery_fee;

    const changeForValue: number | null = null;

    // lógica inteligente de status inicial para pedidos de retirada:
    // - se o pedido tem QUALQUER item que precisa de preparo (lanche, batata, combo)
    //   → fluxo normal (pending_review → preparing → ready_pickup)
    // - se TODOS os itens dispensam preparo (só bebidas, água, refrigerante)
    //   E o cliente vai retirar pessoalmente
    //   → pula o "preparando" e vai direto pra "aguardando retirada"
    // - se for entrega, sempre segue o fluxo normal independente dos itens
    const allItemsNeedNoPrep =
      isPickup &&
      items.every((it) => {
        const prod = productList.find((p: any) => p.id === it.product_id);
        return prod ? prod.needs_preparation === false : false; // desconhecido → assume que precisa de preparo (mais seguro)
      });
    const initialStatus = allItemsNeedNoPrep ? "ready_pickup" : "pending_review";

    // payment_status correto para cada cenário:
    // - Pix agora      → 'awaiting_payment' (pedido só entra na cozinha após confirmar)
    // - Pix na entrega → 'pending' (vai pagar na hora, sem confirmação prévia)
    // - Cartão         → 'pending' (maquininha na entrega)
    // - Dinheiro não é aceito
    const paymentStatus =
      draft.payment_method === "pix" && draft.payment_timing === "now" ? "awaiting_payment" : "pending";

    // payment_timing para cartão sempre é 'delivery' (nunca é 'now')
    const resolvedPaymentTiming = draft.payment_timing ?? (draft.payment_method !== "pix" ? "delivery" : null);

    const orderPayload = {
      source: "whatsapp",
      created_at: new Date().toISOString(),
      customer_name: draft.customer_name,
      customer_phone: conversation.phone,
      delivery_mode: isPickup ? "pickup" : "delivery",
      address_street: isPickup ? null : draft.address_street,
      address_number: isPickup ? null : draft.address_number,
      address_complement: isPickup ? null : (draft.address_complement ?? null),
      address_neighborhood: isPickup ? null : (draft.address_neighborhood ?? null),
      address_city: isPickup ? null : draft.address_city || cfg?.fixed_delivery_city || null,
      address_reference: isPickup ? null : (draft.address_reference ?? null),
      notes: draft.notes ?? null,
      payment_method: draft.payment_method,
      card_type: draft.payment_method === "card" ? (draft.card_type ?? null) : null,
      payment_timing: resolvedPaymentTiming,
      payment_status: paymentStatus,
      change_for: null,
      pix_code: draft.payment_method === "pix" ? cfg?.pix_copia_cola || cfg?.pix_key || null : null,
      subtotal,
      delivery_fee,
      total,
      delivery_distance_km: draft.estimated_distance_km ?? null,
      status: initialStatus,
    };

    // O pedido é gravado na MESMA rodada da primeira confirmação do cliente.
    // Primeiro garantimos a persistência no banco; em seguida enviamos o aviso
    // de até 40 minutos. Assim nunca mostramos "vou gerar" e depois deixamos o
    // cliente sem pedido caso haja uma falha de banco.

    // Caminho principal: pedido + itens são gravados numa única transação no
    // banco. Se qualquer item falhar, o pedido inteiro é revertido.
    const { data: atomicOrder, error: atomicError } = await supabaseAdmin.rpc("create_whatsapp_order_atomic", {
      p_order: orderPayload,
      p_items: items,
    });

    let order: { id: string; order_number: number | null } | null = atomicOrder
      ? { id: String((atomicOrder as any).id), order_number: Number((atomicOrder as any).order_number) }
      : null;

    // Compatibilidade durante implantação: se a migration ainda não foi
    // aplicada, usa o fluxo antigo com rollback compensatório dos itens.
    if (atomicError && /create_whatsapp_order_atomic|PGRST202|schema cache/i.test(String(atomicError.message ?? atomicError.code))) {
      const { data: legacyOrder, error: legacyError } = await supabaseAdmin
        .from("orders")
        .insert(orderPayload)
        .select("id, order_number")
        .single();
      if (legacyError || !legacyOrder) {
        return { result: { status: "error", detail: String(legacyError?.message ?? "erro ao gravar pedido") } };
      }
      const { error: itemsError } = await supabaseAdmin
        .from("order_items")
        .insert(items.map((i) => ({ ...i, order_id: legacyOrder.id })));
      if (itemsError) {
        await supabaseAdmin.from("orders").delete().eq("id", legacyOrder.id);
        return { result: { status: "error", detail: `Falha ao gravar itens do pedido: ${itemsError.message}` } };
      }
      order = legacyOrder;
    } else if (atomicError || !order) {
      console.error("finalize_order: transação falhou —", atomicError);
      return {
        result: {
          status: "error",
          detail: String(atomicError?.message ?? "erro desconhecido ao gravar pedido e itens"),
        },
      };
    }

    // Pedido criado com sucesso: agora informa o prazo. Não pede e não aguarda
    // nenhuma nova aprovação. A criação já aconteceu automaticamente nesta
    // mesma rodada da confirmação final.
    if (!isPickup) {
      await replyAndLog(
        supabaseAdmin,
        conversation.id,
        conversation.phone,
        "Perfeito! O prazo de entrega é de até 40 minutos, porém a maioria das nossas entregas acontece bem antes desse prazo. Acompanhe as atualizações por aqui no WhatsApp, pois vamos avisando cada etapa do seu pedido.",
        { systemMessage: true },
      );
    }

    // captura antes de limpar o rascunho (precisamos disso pra decidir se manda o bloco do Pix)
    const finishedPaymentMethod = draft.payment_method;
    const finishedPaymentTiming = draft.payment_timing;

    // IMPORTANTE: não apaga o rascunho inteiro — mantém o ENDEREÇO (é comum o
    // mesmo cliente fechar vários pedidos separados pro mesmo endereço, cada
    // um com pessoa/pagamento diferente, tipo "3 lanches, cada um pra uma
    // pessoa, formas de pagamento diferentes"). Só limpa o que é específico
    // de UM pedido (nome do destinatário, itens, pagamento).
    await supabaseAdmin
      .from("order_drafts")
      .update({
        customer_name: null,
        items: [],
        payment_method: null,
        card_type: null,
        payment_timing: null,
        change_for: null,
        notes: null,
        failed_finalize_attempts: 0,
        awaiting_final_confirmation: false,
        updated_at: new Date().toISOString(),
      })
      .eq("conversation_id", conversation.id);
    draft.customer_name = null;
    draft.failed_finalize_attempts = 0;
    draft.awaiting_final_confirmation = false;
    draft.items = [];
    draft.payment_method = null;
    draft.card_type = null;
    draft.payment_timing = null;
    draft.change_for = null;
    draft.notes = null;

    // Pix agora são TRÊS mensagens separadas:
    // 1ª: resumo do pedido + instrução de comprovante (sem a chave)
    // 2ª: só o título ("Chave aleatória:" ou "Chave Pix:"), sozinho
    // 3ª: só a chave, SEM NENHUM texto junto — assim o cliente consegue
    //     segurar e copiar só o código, sem precisar editar o que copiou
    let pixKeyLabel: string | null = null;
    let pixKeyMessage: string | null = null;
    let pixSummaryExtra: string | null = null;
    if (finishedPaymentMethod === "pix" && finishedPaymentTiming === "now") {
      const code = cfg?.pix_copia_cola || cfg?.pix_key;
      if (code) {
        pixSummaryExtra = `\n\n💳 *Pagamento via Pix*\n💰 Valor: *R$ ${total.toFixed(2).replace(".", ",")}*\n\n📸 Assim que pagar, me manda o *comprovante em foto* aqui mesmo. A loja vai conferir o pagamento antes de liberar o pedido para preparo. 🙏`;
        const isAleatoria = code.length > 30 || code.includes("-");
        pixKeyLabel = isAleatoria ? "🔑 Pix é chave aleatória:" : "🔑 Pix é chave:";
        // mensagem da chave: só o código, nada mais, pra copiar limpo
        pixKeyMessage = code;
      }
    }

    // recibo formatado — sempre enviado, independente do que a IA escrever antes,
    // assim a confirmação nunca sai desorganizada ou incompleta
    const itemsList = items.map((i) => `▫️ ${i.quantity}x ${i.product_name}`).join("\n");
    const addressLine = [
      draft.address_street && `${draft.address_street}, ${draft.address_number}`,
      draft.address_complement,
      draft.address_neighborhood,
      draft.address_city,
    ]
      .filter(Boolean)
      .join(" — ");
    const paymentLabel =
      finishedPaymentMethod === "pix" ? "Pix" : "Cartão";
    const paymentLine =
      finishedPaymentMethod === "pix"
        ? `💳 Pagamento: *Pix* (${finishedPaymentTiming === "now" ? "pago agora" : "na entrega"})`
        : `💳 Pagamento: *Cartão na entrega* (crédito à vista ou débito)`;

    // mensagem de status diferente para retirada vs entrega, e para direto na prateleira vs. preparo
    const closingLine = isPickup
      ? allItemsNeedNoPrep
        ? "📦 Seu pedido já está disponível para retirada. Pode vir buscar quando quiser."
        : "⏱️ Já vamos preparar tudo. Aviso quando estiver pronto para retirada."
      : "⏱️ Já entra na fila de preparo. Em breve sai para entrega.";

    const receiptBlock =
      `✅ *Pedido confirmado!*\n\n` +
      `📋 Pedido *${orderNumberFmt(order.order_number)}*\n\n` +
      `🍽️ *Itens:*\n${itemsList}\n\n` +
      `Subtotal: ${brl(subtotal)}\n` +
      (isPickup ? "" : `Entrega: ${brl(delivery_fee)}\n`) +
      `*Total: ${brl(total)}*\n\n` +
      (isPickup ? `🏪 *Retirada no local*\n\n` : `📍 *Endereço:*\n${addressLine || "—"}\n\n`) +
      `${paymentLine}` +
      (pixSummaryExtra ?? "") +
      `\n\n${closingLine}`;

    return {
      result: { status: "ok", order_number: order.order_number, total, same_address_kept: true },
      pixBlock: receiptBlock,
      pixKeyLabel, // null se não for Pix — título da chave, mandado antes da chave em si
      pixKeyMessage, // null se não for Pix — só o código, sozinho, pra copiar limpo
    };
  }


  if (name === "update_active_order_items" || name === "cancel_active_order_item" || name === "cancel_active_order") {
    const { data: activeOrder } = await supabaseAdmin
      .from("orders")
      .select("id,order_number,status,subtotal,total,delivery_fee,coupon_discount,source")
      .eq("customer_phone", conversation.phone)
      .not("status", "in", "(delivered,cancelled,failed)")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!activeOrder) return { result: { status: "no_active_order" } };

    if (name === "cancel_active_order") {
      const reasonText = String(args.reason ?? "").trim();
      const cancelReason = reasonText
        ? `Cliente cancelou pelo WhatsApp: ${reasonText}`
        : "Cliente cancelou o pedido pelo WhatsApp";
      const { error } = await supabaseAdmin
        .from("orders")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          cancel_reason: cancelReason,
          customer_cancel_requested: false,
          customer_cancel_reason: cancelReason,
        })
        .eq("id", activeOrder.id);
      if (error) return { result: { status: "error", detail: error.message } };
      // A mudança de status já aciona a mensagem automática de cancelamento do sistema.
      ctx.flags.silenced = true;
      return { result: { status: "ok", action: "order_cancelled", order_number: activeOrder.order_number } };
    }

    const { data: currentRows, error: currentErr } = await supabaseAdmin
      .from("order_items")
      .select("id,product_id,product_name,quantity,unit_price,list_price,is_promotion_price,notes")
      .eq("order_id", activeOrder.id)
      .order("created_at", { ascending: true });
    if (currentErr) return { result: { status: "error", detail: currentErr.message } };

    let desired: { product_name: string; quantity: number; notes?: string | null }[] = [];
    if (name === "update_active_order_items") {
      desired = Array.isArray(args.items)
        ? args.items
            .map((it: any) => ({
              product_name: String(it.product_name ?? "").trim(),
              quantity: Math.max(0, Math.round(Number(it.quantity) || 0)),
              notes: it.notes ? String(it.notes) : null,
            }))
            .filter((it: any) => it.product_name && it.quantity > 0)
        : [];
    } else {
      const rawName = String(args.product_name ?? "").trim();
      if (!rawName) return { result: { status: "missing_product_name" } };
      const { findProductMatch } = await import("@/lib/product-match.server");
      const currentAsProducts = (currentRows ?? []).map((r: any) => ({ id: r.id, name: r.product_name }));
      const matchedCurrent = findProductMatch(currentAsProducts, rawName);
      if (!matchedCurrent) {
        return {
          result: {
            status: "item_not_found_in_order",
            item: rawName,
            current_items: (currentRows ?? []).map((r: any) => `${r.quantity}x ${r.product_name}`),
          },
        };
      }
      const removeQtyRaw = args.quantity == null ? null : Math.max(1, Math.round(Number(args.quantity) || 1));
      desired = (currentRows ?? []).map((r: any) => ({
        product_name: r.product_name,
        quantity:
          r.id === matchedCurrent.id
            ? removeQtyRaw == null
              ? 0
              : Math.max(0, Number(r.quantity) - removeQtyRaw)
            : Number(r.quantity),
        notes: r.notes ?? null,
      })).filter((it: any) => it.quantity > 0);
    }

    if (!desired.length) {
      const cancelReason = "Cliente cancelou todos os itens do pedido pelo WhatsApp";
      const { error } = await supabaseAdmin
        .from("orders")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          cancel_reason: cancelReason,
          customer_cancel_requested: false,
          customer_cancel_reason: cancelReason,
        })
        .eq("id", activeOrder.id);
      if (error) return { result: { status: "error", detail: error.message } };
      ctx.flags.silenced = true;
      return { result: { status: "ok", action: "order_cancelled_no_items", order_number: activeOrder.order_number } };
    }

    const { data: products } = await supabaseAdmin
      .from("products")
      .select("id,name,sale_price,promotion_active,promotion_price,promotion_type,promotion_start_at,promotion_end_at,promotion_days_of_week,promotion_time_start,promotion_time_end,promotion_label")
      .eq("active", true);
    const productList = products ?? [];
    const { findProductMatch, findProductSuggestions } = await import("@/lib/product-match.server");
    const unmatched: any[] = [];
    const repriced = desired.map((it) => {
      const match = findProductMatch(productList, it.product_name);
      if (!match) {
        unmatched.push({ raw: it.product_name, closest: findProductSuggestions(productList, it.product_name) });
      }
      const effective = match ? getEffectivePrice(match) : { price: 0, listPrice: 0, isPromotion: false };
      return {
        product_id: match?.id ?? null,
        product_name: match?.name ?? it.product_name,
        quantity: it.quantity,
        unit_price: effective.price,
        list_price: effective.listPrice,
        is_promotion_price: effective.isPromotion,
        notes: it.notes ?? null,
      };
    });
    if (unmatched.length) return { result: { status: "unmatched_products", suggestions: unmatched } };

    const subtotal = repriced.reduce((sum, it) => sum + Number(it.unit_price) * Number(it.quantity), 0);
    const couponDiscount = Number(activeOrder.coupon_discount ?? 0);
    const deliveryFee = Number(activeOrder.delivery_fee ?? 0);
    const total = Math.max(0, subtotal - couponDiscount) + deliveryFee;

    const { error: rpcError } = await supabaseAdmin.rpc("update_whatsapp_order_items_atomic", {
      p_order_id: activeOrder.id,
      p_items: repriced,
      p_subtotal: subtotal,
      p_total: total,
    });
    if (rpcError) {
      // Compatibilidade caso a migration nova ainda não tenha sido aplicada.
      if (/update_whatsapp_order_items_atomic|PGRST202|schema cache/i.test(String(rpcError.message ?? rpcError.code))) {
        const { error: delErr } = await supabaseAdmin.from("order_items").delete().eq("order_id", activeOrder.id);
        if (delErr) return { result: { status: "error", detail: delErr.message } };
        const { error: insErr } = await supabaseAdmin
          .from("order_items")
          .insert(repriced.map((it) => ({ ...it, order_id: activeOrder.id })));
        if (insErr) return { result: { status: "error", detail: insErr.message } };
        const { error: updErr } = await supabaseAdmin
          .from("orders")
          .update({ subtotal, total })
          .eq("id", activeOrder.id);
        if (updErr) return { result: { status: "error", detail: updErr.message } };
      } else {
        return { result: { status: "error", detail: rpcError.message } };
      }
    }

    const itemLines = repriced.map((it) => `- ${it.quantity}x ${it.product_name} — ${brl(it.quantity * it.unit_price)}`).join("\n");
    const updateText =
      `Pedido *${orderNumberFmt(activeOrder.order_number)}* atualizado com sucesso.\n\n` +
      `*Itens atuais:*\n${itemLines}\n\n` +
      `*Subtotal:* ${brl(subtotal)}\n` +
      (couponDiscount > 0 ? `*Desconto:* -${brl(couponDiscount)}\n` : "") +
      `*Taxa de entrega:* ${brl(deliveryFee)}\n` +
      `*Novo total a pagar:* ${brl(total)}`;
    await replyAndLog(supabaseAdmin, conversation.id, conversation.phone, updateText, { systemMessage: true });
    ctx.flags.silenced = true;
    return {
      result: {
        status: "ok",
        action: name === "cancel_active_order_item" ? "item_cancelled" : "order_updated",
        order_number: activeOrder.order_number,
        subtotal,
        delivery_fee: deliveryFee,
        total,
      },
    };
  }

  if (name === "request_order_cancellation") {
    const { data: activeOrder } = await supabaseAdmin
      .from("orders")
      .select("id, order_number")
      .eq("customer_phone", conversation.phone)
      .not("status", "in", "(delivered,cancelled,failed)")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!activeOrder) return { result: { status: "no_active_order" } };

    const { error } = await supabaseAdmin
      .from("orders")
      .update({
        customer_cancel_requested: true,
        customer_cancel_reason: args.reason ?? null,
      })
      .eq("id", activeOrder.id);

    if (error) return { result: { status: "error", detail: error.message } };
    return { result: { status: "ok", order_number: activeOrder.order_number } };
  }

  if (name === "lookup_place_address") {
    // O cliente citou um estabelecimento pelo nome ("mercado do zé", "posto tal")
    // em vez de um endereço. Antes de dizer se entrega ou não, o sistema
    // descobre o endereço real (e o bairro) desse lugar na cidade atendida.
    const placeName = String(args.place_name ?? "").trim();
    if (!placeName) return { result: { status: "missing_place_name" } };
    try {
      const { data: cfgRow } = await supabaseAdmin
        .from("store_config")
        .select("google_maps_api_key, store_lat, store_lng, fixed_delivery_city")
        .maybeSingle();
      const city = cfgRow?.fixed_delivery_city || "Duque de Caxias";
      const { geocodeAddress } = await import("@/lib/delivery-distance.server");
      const found = await geocodeAddress(
        `${placeName}, ${city} - RJ, Brasil`,
        cfgRow?.google_maps_api_key ?? null,
        cfgRow?.store_lat != null ? Number(cfgRow.store_lat) : null,
        cfgRow?.store_lng != null ? Number(cfgRow.store_lng) : null,
        city,
      );
      if (!found) return { result: { status: "place_not_found", place_name: placeName } };
      const bloqueado = found.bairro ? isBairroNaoAtendido(found.bairro, bairrosNaoAtendidos) : false;
      const atendido = resolveBairroStatus(found.bairro, bairrosAtendidos, bairrosNaoAtendidos);
      return {
        result: {
          status: "ok",
          place_name: placeName,
          city,
          neighborhood: found.bairro,
          atendido, // true/false = decisão definitiva (bloqueio ou bairros_atendidos cadastrado); null = sem lista cadastrada ou bairro não identificado, decida pelas INSTRUÇÕES DO GERENTE
          instruction: bloqueado
            ? `O lugar "${placeName}" fica no bairro ${found.bairro}, que está na lista oficial de BAIRROS NÃO ATENDIDOS. NÃO diga simplesmente que não entrega — siga o fluxo de REDIRECIONAMENTO FORA DE ÁREA (iFood/99Food) descrito no prompt. Essa checagem já é definitiva, não precisa reconsiderar.`
            : atendido === true
              ? `O lugar "${placeName}" fica no bairro ${found.bairro}, que ESTÁ na lista oficial de bairros atendidos. Confirme que a loja entrega lá e siga o atendimento normalmente (peça rua e número) — não diga que não atende, essa checagem já é definitiva.`
              : atendido === false
                ? `O lugar "${placeName}" fica no bairro ${found.bairro}, que NÃO está na lista oficial de bairros atendidos. NÃO diga simplesmente que não entrega — siga o fluxo de REDIRECIONAMENTO FORA DE ÁREA (iFood/99Food) descrito no prompt. Essa checagem já é definitiva, não precisa reconsiderar.`
                : found.bairro
                  ? `O lugar "${placeName}" fica no bairro ${found.bairro}. Compare esse bairro com a lista de bairros atendidos nas INSTRUÇÕES DO GERENTE: se ele estiver na lista, confirme que a loja entrega lá e siga o atendimento normalmente. Só siga o fluxo de REDIRECIONAMENTO FORA DE ÁREA se esse bairro realmente não estiver na lista.`
                  : `Não deu pra identificar o bairro exato de "${placeName}". Peça ao cliente o bairro (e a rua) em vez de afirmar que não entrega.`,
        },
      };
    } catch {
      return { result: { status: "place_lookup_failed", place_name: placeName } };
    }
  }

  if (name === "send_menu_image") {
    // Só marca a intenção aqui — quem realmente envia a(s) imagem(ns) é o
    // handler principal, depois que a resposta em texto desta rodada for
    // enviada ao cliente (mesma lógica do pixBlock: o envio de mídia
    // acontece fora do loop da IA, com acesso a phone/conversationId).
    if (ctx.flags) ctx.flags.sendMenuImage = true;
    return {
      result: {
        status: "ok",
        message: "A imagem do cardápio será enviada ao cliente logo em seguida.",
      },
    };
  }

  return { result: { status: "unknown_tool" } };
}

/**
 * Trava de segurança do frete: a IA NUNCA pode mandar um valor de taxa de
 * entrega que não tenha passado pela aprovação da loja (popup de 30s).
 * Aqui, antes de a mensagem sair pro cliente:
 *  - se já existe uma taxa aprovada/liberada no rascunho, qualquer valor de
 *    frete escrito pela IA é substituído por esse valor exato;
 *  - se ainda NÃO existe taxa liberada, toda frase que anuncia um valor de
 *    entrega é removida da mensagem.
 * Foi isso que gerou o caso de o cliente receber R$ 6,00 (chute da IA) e
 * depois R$ 7,50 (valor real aprovado).
 */
export function enforceApprovedFreight(text: string, draft: Draft): string {
  if (!text) return text;
  const approved = draft.delivery_mode === "pickup" ? null : (draft.estimated_delivery_fee ?? null);
  const approvedLabel = approved != null ? `R$ ${Number(approved).toFixed(2).replace(".", ",")}` : null;
  const moneyReTest = /R\$\s?\d{1,4}(?:[.,]\d{2})?/;
  const freightRe = /(taxa de entrega|taxa da entrega|frete|entrega custa|valor da entrega)/i;

  const parts = text.split(/(?<=[.!?\n])/);
  const out = parts
    .map((sentence) => {
      if (!freightRe.test(sentence) || !moneyReTest.test(sentence)) return sentence;
      if (/total|subtotal/i.test(sentence)) return sentence;
      if (approvedLabel) return sentence.replace(/R\$\s?\d{1,4}(?:[.,]\d{2})?/g, approvedLabel);
      return "";
    })
    .join("");

  const cleaned = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) {
    return "Só um momento que já confirmo o valor da taxa de entrega para esse endereço.";
  }
  return cleaned;
}

// ============================================================
// Loop de conversa com a IA (function-calling multi-turno)
// ============================================================

function buildDeliveryInfoText(opts: {
  pricingMode: string;
  maxRadiusKm: number | null;
  flatFee: number;
  draft: Draft;
}): string {
  const { pricingMode, maxRadiusKm, flatFee, draft } = opts;

  if (pricingMode !== "distance") {
    return `TAXA DE ENTREGA: ${flatFee > 0 ? `R$ ${flatFee.toFixed(2).replace(".", ",")}` : "grátis"} (valor fixo, some ao total do pedido).`;
  }

  // modo por distância: NUNCA fale de bairros específicos — a entrega é decidida
  // pela distância em km até o endereço, calculada automaticamente.
  if (draft.out_of_delivery_area) {
    return `A ENTREGA PRA ESSE ENDEREÇO ESTÁ FORA DA ÁREA DE COBERTURA (além de ${maxRadiusKm ?? "?"} km da loja). NÃO diga simplesmente que não entregamos — siga o fluxo de REDIRECIONAMENTO FORA DE ÁREA (iFood/99Food) descrito no prompt.`;
  }
  if (draft.estimated_delivery_fee != null) {
    return `TAXA DE ENTREGA PRA ESSE ENDEREÇO: R$ ${Number(draft.estimated_delivery_fee).toFixed(2).replace(".", ",")}${draft.estimated_distance_km != null ? ` (${draft.estimated_distance_km.toFixed(1)} km da loja)` : ""} — já calculada, pode informar esse valor exato ao cliente.`;
  }
  return `A TAXA DE ENTREGA é calculada automaticamente pela distância até o endereço do cliente${maxRadiusKm ? ` — entregamos em um raio de até ${maxRadiusKm} km da loja` : ""}. IMPORTANTE: se as INSTRUÇÕES DO GERENTE (no topo) listarem bairros ou regiões específicas onde a loja atende, siga aquela lista à risca — nunca prometa entrega em bairro que não esteja lá. Se o cliente pedir entrega pra um lugar que claramente não está na área atendida pelo gerente, avise com educação que a loja não atende essa região e não peça o endereço completo. Só depois de o cliente confirmar um endereço dentro da área é que o valor exato da taxa é calculado.`;
}

function buildBairrosAtendidosText(bairrosAtendidosText: string | null): string {
  if (!bairrosAtendidosText) return "";
  return `\n📍 BAIRROS ATENDIDOS — LISTA OFICIAL CADASTRADA PELA LOJA (fonte de verdade sobre área de entrega, mais confiável que qualquer cálculo por distância): ${bairrosAtendidosText}\nO sistema já confere automaticamente o bairro informado pelo cliente contra essa lista antes de calcular a taxa — se o bairro estiver aqui, o pedido NUNCA será marcado como fora de área, mesmo que o cálculo por km diga o contrário. Se "O QUE JÁ SEI SOBRE O PEDIDO" indicar endereço fora da área mesmo assim, confira se o bairro dito pelo cliente bate com um destes antes de recusar — pode ser erro de digitação ou de grafia (ex: acento, abreviação). Fora dessa lista, siga o fluxo de REDIRECIONAMENTO FORA DE ÁREA (iFood/99Food) descrito no prompt.\n`;
}

// 🚫 BAIRROS/RUAS NÃO ATENDIDOS — listas negativas explícitas cadastradas
// pela loja. Têm prioridade MÁXIMA: valem mais até do que a lista de
// bairros atendidos e do que qualquer instrução solta no texto livre do
// gerente. O sistema já bloqueia essas áreas em código (applyBairroOverride)
// antes mesmo da IA responder — este texto é uma segunda camada de
// segurança, pra IA nunca afirmar o contrário em texto livre (ex: quando o
// cliente só pergunta "vocês entregam aí?" sem chegar a informar endereço
// completo, ou cita um bairro/rua sem ainda ter passado por update_order_draft).
function buildBairrosNaoAtendidosText(bairrosNaoAtendidosText: string | null): string {
  if (!bairrosNaoAtendidosText) return "";
  return `\n🚫 BAIRROS NÃO ATENDIDOS — LISTA OFICIAL CADASTRADA PELA LOJA (bloqueio definitivo, prioridade máxima sobre QUALQUER outra informação deste prompt, inclusive sobre a lista de bairros atendidos e sobre as instruções do gerente): ${bairrosNaoAtendidosText}\nSe o bairro citado ou informado pelo cliente estiver nesta lista (mesmo com pequena diferença de grafia/acento), o entregador fixo da loja NUNCA vai até esse bairro — nunca diga que entrega por WhatsApp, nunca diga "vou verificar", nunca peça o restante do endereço pra "confirmar depois". Mas NÃO diga simplesmente que a loja não entrega ali: siga o fluxo de REDIRECIONAMENTO FORA DE ÁREA (iFood/99Food) descrito no prompt.\n`;
}

function buildRuasNaoAtendidasText(ruasNaoAtendidasText: string | null): string {
  if (!ruasNaoAtendidasText) return "";
  return `\n🚫 RUAS NÃO ATENDIDAS — LISTA OFICIAL CADASTRADA PELA LOJA (bloqueio definitivo, mesma prioridade máxima da lista de bairros não atendidos): ${ruasNaoAtendidasText}\nSe a rua citada ou informada pelo cliente estiver nesta lista (mesmo com pequena diferença de grafia/abreviação, ex: "R." vs "Rua"), o entregador fixo da loja NUNCA vai até essa rua, mesmo que o bairro dessa rua esteja na lista de bairros atendidos — a rua bloqueada vale mais que o bairro liberado. Siga o fluxo de REDIRECIONAMENTO FORA DE ÁREA (iFood/99Food) descrito no prompt, nunca diga simplesmente que não entrega.\n`;
}

// 🚗 FORA DA ÁREA DE ENTREGA — links da loja no iFood/99Food (Configurações
// → Integrações). Quando um endereço está fora do alcance do entregador
// fixo da loja (bairro/rua não atendidos, ou fora do raio por distância),
// em vez de simplesmente recusar a entrega, a IA oferece o pedido pela loja
// no iFood/99Food — plataformas que têm entregadores próprios cobrindo
// regiões que o entregador fixo não cobre. Só oferece e só manda o link se
// o lojista realmente tiver cadastrado ao menos um dos dois; sem isso, cai
// no fallback antigo (avisa educadamente que não entrega, sem mencionar
// nenhuma plataforma nem inventar link).
function buildOutOfAreaLinksText(ifoodLink: string | null, nfoodLink: string | null): string {
  if (!ifoodLink && !nfoodLink) {
    return `\n🚗 FORA DA ÁREA DE ENTREGA — SEM LINK CADASTRADO: a loja ainda não cadastrou nenhum link da loja no iFood ou na 99Food (Configurações → Integrações). Enquanto não houver link cadastrado, quando um endereço estiver fora da área do entregador fixo, apenas avise o cliente com educação que infelizmente a loja não consegue entregar nessa região no momento — NÃO mencione iFood nem 99Food, e não prometa nenhum link, já que não existe nenhum cadastrado ainda.\n`;
  }
  const linhas: string[] = [];
  if (ifoodLink) linhas.push(`- iFood: ${ifoodLink}`);
  if (nfoodLink) linhas.push(`- 99Food: ${nfoodLink}`);
  const nomesPlataformas = [ifoodLink ? "iFood" : null, nfoodLink ? "99Food" : null].filter(Boolean).join(" e ");
  return `\n🚗 FORA DA ÁREA DE ENTREGA — FLUXO DE REDIRECIONAMENTO PRO ${nomesPlataformas.toUpperCase()}: siga esse fluxo sempre que um endereço, bairro ou rua estiver fora da área atendida pelo entregador fixo da loja (bairro/rua na lista de NÃO atendidos, endereço fora da lista de bairros atendidos quando ela existe, ou fora do raio calculado por distância).

🚫 PROIBIDO: dizer "não entregamos" ou qualquer variação negativa. PROIBIDO pedir confirmação antes de mandar os links. NUNCA pergunte "você quer que eu mande o link?" — envie IMEDIATAMENTE já na PRIMEIRA mensagem sobre esse endereço a resposta abaixo, com os links organizados:\n\nResponda com exatamente este espírito (adapte apenas o pronome de tratamento se necessário, mas mantenha o texto positivo e os links):\n"Entregamos na sua área sim! Porém, para o seu bairro, o pedido precisa ser feito pela nossa loja no iFood ou 99Food, pois os entregadores dos apps é que cobrem essa região. A nossa loja é HotBox Delivery, abaixo está o link direto da nossa loja, lá você encontra o cardápio e os valores:\n\n${linhas.join("\\n")}"\n\nREGRAS OBRIGATÓRIAS:\n- Envie os links JÁ na primeira mensagem — NUNCA primeiro pergunte se o cliente quer o link.\n- NUNCA diga "infelizmente não entregamos", "nossa área não cobre" ou qualquer variação negativa.\n- Inclua SEMPRE os links disponíveis na mesma mensagem, de forma organizada, um por linha.\n- Depois desse redirecionamento, NUNCA finalize um pedido pelo WhatsApp pra esse endereço.\n`;
}

async function runConversationalTurn(opts: {
  supabaseAdmin: any;
  conversation: any;
  draft: Draft;
  history: { role: string; content: string }[];
  storeName: string;
  catalogText: string;
  unavailableText: string;
  categoriesText: string;
  pushName?: string;
  pricingMode: string;
  maxRadiusKm: number | null;
  flatFee: number;
  deliveryTimeMinutes: number | null;
  lastOrderText: string | null;
  lastAddressText: string | null;
  aiInstructionsText: string | null;
  bairrosAtendidos: string[];
  bairrosAtendidosText: string | null;
  bairrosNaoAtendidos: string[];
  bairrosNaoAtendidosText: string | null;
  ruasNaoAtendidas: string[];
  ruasNaoAtendidasText: string | null;
  forceNoTools: boolean;
  businessHoursText: string | null;
  outOfAreaLinksText: string;
}): Promise<{
  silenced?: boolean;
  finalText: string;

  pixBlock: string | null;
  pixKeyLabel: string | null;
  pixKeyMessage: string | null;
  sendMenuImage?: boolean;
}> {
  const deliveryInfoText =
    buildDeliveryInfoText({
      pricingMode: opts.pricingMode,
      maxRadiusKm: opts.maxRadiusKm,
      flatFee: opts.flatFee,
      draft: opts.draft,
    }) +
    buildBairrosAtendidosText(opts.bairrosAtendidosText) +
    buildBairrosNaoAtendidosText(opts.bairrosNaoAtendidosText) +
    buildRuasNaoAtendidasText(opts.ruasNaoAtendidasText) +
    opts.outOfAreaLinksText;
  // ============ CONTEXTO DE TURNO ============
  // O modelo não tem noção nativa de "primeiro contato vs conversa em andamento"
  // — o prompt é reconstruído do zero a cada mensagem e ele tende a tratar tudo
  // como início de atendimento (daí as reapresentações em loop). Aqui o CÓDIGO
  // conta o histórico e injeta essa informação de forma explícita e inequívoca.
  const assistantTurns = opts.history.filter((m) => m.role === "assistant").length;
  const hasManualAgentContext = opts.history.some((m) => m.role === "assistant" && m.content.includes("[ATENDENTE HUMANO DA LOJA]"));
  const isFirstContact = assistantTurns === 0;
  const manualContinuationRule = hasManualAgentContext
    ? `\n🤝 CONTINUIDADE APÓS ATENDIMENTO HUMANO: existem mensagens marcadas como [ATENDENTE HUMANO DA LOJA] no histórico. Trate tudo que esse atendente disse, combinou, confirmou ou perguntou como contexto oficial e já conhecido. Continue exatamente do ponto onde ele parou, sem reiniciar o atendimento, sem pedir novamente dados já informados e sem contradizer o atendente. NUNCA escreva a marca [ATENDENTE HUMANO DA LOJA] para o cliente.`
    : "";
  const conversationStageText = (isFirstContact
    ? `🟢 CONTEXTO: este é o PRIMEIRO CONTATO deste cliente com a loja (não há nenhuma resposta sua no histórico). Cumprimente UMA vez com "${greetingByTimeBR()}". Se o cliente não declarou RETIRADA, a única pergunta operacional permitida antes de qualquer outra informação é o BAIRRO; não pergunte "como posso ajudar" antes de validar o bairro.`
    : `⛔ CONTEXTO: esta é uma CONVERSA EM ANDAMENTO — você já respondeu ${assistantTurns} vez(es) neste chat. É PROIBIDO cumprimentar de novo, se apresentar, dizer o nome da loja como abertura ou perguntar "como posso ajudar". Leia o histórico abaixo e responda APENAS a última mensagem do cliente, continuando de onde a conversa parou.`) + manualContinuationRule;

  const systemPrompt = buildSystemPrompt(
    opts.storeName,
    opts.catalogText,
    opts.unavailableText,
    opts.categoriesText,
    opts.draft,
    deliveryInfoText,
    opts.deliveryTimeMinutes,
    opts.lastOrderText,
    opts.lastAddressText,
    opts.aiInstructionsText,
    opts.pushName,
    conversationStageText,
    opts.businessHoursText,
  );
  const messages: any[] = [{ role: "system", content: systemPrompt }, ...opts.history];
  let pixBlock: string | null = null;
  let pixKeyLabel: string | null = null;
  let pixKeyMessage: string | null = null;
  let finalText = "";
  // Marcado quando o gerente recusa o valor de frete: a conversa vira manual e
  // a IA não responde nada nesse turno.
  const flags: { silenced?: boolean; sendMenuImage?: boolean } = {};
  const lastUserIndex = (() => {
    for (let i = opts.history.length - 1; i >= 0; i--) {
      if (opts.history[i]?.role === "user") return i;
    }
    return -1;
  })();
  const lastUserText = lastUserIndex >= 0 ? (opts.history[lastUserIndex]?.content ?? "") : "";

  // A confirmação final não depende mais de uma frase exata da IA. Procura a
  // última mensagem real do atendente imediatamente antes da resposta atual,
  // ignorando eventuais mensagens internas/ferramentas que possam ter entrado
  // entre o resumo e o "sim" do cliente. Isso elimina o loop em que o backend
  // esquecia que já havia pedido confirmação e mandava o mesmo resumo de novo.
  const confirmationRequestPattern =
    /(est[aá] (?:correto|tudo certo|certinho)|confere|confirma(?:r)?(?: o pedido)?|pode (?:confirmar|fechar|finalizar)|posso (?:confirmar|fechar|finalizar)|podemos (?:confirmar|fechar|finalizar|concluir)|resumo do pedido|pedido est[aá] correto)/i;
  let previousAssistantRequestedConfirmation = false;
  if (lastUserIndex > 0) {
    for (let i = lastUserIndex - 1; i >= Math.max(0, lastUserIndex - 6); i--) {
      const msg = opts.history[i];
      if (msg?.role === "assistant" && confirmationRequestPattern.test(msg.content ?? "")) {
        previousAssistantRequestedConfirmation = true;
        break;
      }
      // Outra fala do cliente antes de encontrarmos a confirmação significa que
      // o "sim" atual não pertence mais àquele resumo antigo.
      if (msg?.role === "user") break;
    }
  }
  const finalConfirmationAllowed =
    isExplicitOrderConfirmation(lastUserText) &&
    (Boolean(opts.draft.awaiting_final_confirmation) || previousAssistantRequestedConfirmation);

  // Caminho determinístico: se o cliente acabou de confirmar explicitamente o
  // resumo, o backend fecha o pedido antes de consultar a IA. Assim o modelo
  // não consegue decidir repetir o resumo/pergunta e criar um loop infinito.
  if (finalConfirmationAllowed && !opts.forceNoTools) {
    // LOCK OTIMISTA CONTRA WEBHOOK DUPLICADO/RACE CONDITION:
    // apenas uma execução pode consumir awaiting_final_confirmation=true.
    // Se a Evolution reenviar o mesmo evento ou dois workers processarem o
    // mesmo "sim" ao mesmo tempo, o segundo é silenciado e NÃO repete resumo.
    const { data: claimedConfirmation, error: claimError } = await opts.supabaseAdmin
      .from("order_drafts")
      .update({ awaiting_final_confirmation: false, updated_at: new Date().toISOString() })
      .eq("conversation_id", opts.conversation.id)
      .eq("awaiting_final_confirmation", true)
      .select("conversation_id")
      .maybeSingle();
    if (claimError) {
      messages.push({ role: "system", content: `[falha ao reservar confirmação final] ${claimError.message}` });
    } else if (!claimedConfirmation) {
      return {
        silenced: true,
        finalText: "",
        pixBlock: null,
        pixKeyLabel: null,
        pixKeyMessage: null,
        sendMenuImage: false,
      };
    }
    opts.draft.awaiting_final_confirmation = false;

    const direct = await executeTool("finalize_order", {}, {
      supabaseAdmin: opts.supabaseAdmin,
      conversation: opts.conversation,
      draft: opts.draft,
      flags,
      finalConfirmationAllowed: true,
      bairrosAtendidos: opts.bairrosAtendidos,
      bairrosNaoAtendidos: opts.bairrosNaoAtendidos,
      ruasNaoAtendidas: opts.ruasNaoAtendidas,
    });

    if (direct.result?.status === "ok") {
      return {
        finalText: "",
        pixBlock: direct.pixBlock ?? null,
        pixKeyLabel: direct.pixKeyLabel ?? null,
        pixKeyMessage: direct.pixKeyMessage ?? null,
        sendMenuImage: false,
      };
    }

    // A confirmação já foi consumida. Qualquer novo ajuste de dados precisa
    // gerar um NOVO resumo; nunca reaproveite o resumo anterior.
    opts.draft.awaiting_final_confirmation = false;
    await opts.supabaseAdmin
      .from("order_drafts")
      .update({ awaiting_final_confirmation: false, updated_at: new Date().toISOString() })
      .eq("conversation_id", opts.conversation.id);

    // Se a validação estrutural impedir o fechamento (campo faltando, estoque,
    // etc.), não tenta finalizar de novo nesta mesma rodada. Entrega o motivo
    // para a IA pedir SOMENTE o que falta.
    messages.push({
      role: "system",
      content: `[tentativa direta de finalizar após confirmação] ${JSON.stringify(direct.result)}`,
    });
  }

  for (let round = 0; round < 6; round++) {
    const json = await callChatCompletion(opts.supabaseAdmin, {
      messages,
      tools: TOOLS,
      tool_choice: opts.forceNoTools ? "none" : "auto",
    });
    if (!json) {
      // Os dois provedores de IA falharam nessa chamada (chave inválida, sem
      // crédito, endpoint fora do ar, etc). Isso é o que gera o fallback
      // genérico em TODA mensagem — e sem alerta, o lojista não sabe o motivo.
      // Registra um alerta visível em /loja (painel) pra facilitar o diagnóstico.
      try {
        await opts.supabaseAdmin.rpc("record_system_alert", {
          _kind: "ia_indisponivel",
          _message:
            "A IA não respondeu (ChatGPT e Groq falharam ou não estão configurados). O cliente está recebendo mensagem de instabilidade. Confira as chaves em Configurações → IA / Failover.",
          _severity: "error",
        });
      } catch {
        /* alerta não pode quebrar o fluxo */
      }
      break;
    }
    const msg = json?.choices?.[0]?.message;
    if (!msg) break;

    // Blindagem: alguns provedores (Groq/Llama, principalmente) às vezes
    // escrevem a chamada de ferramenta como texto cru dentro de `content`
    // (formato "<function=nome>{...}</function>") em vez de usar o campo
    // estruturado `tool_calls`. Extrai e executa essas chamadas aqui, e
    // NUNCA deixa esse texto cru entrar no histórico ou chegar ao cliente.
    const { calls: inlineCalls, cleanedText } = extractInlineFunctionCalls(msg.content);
    messages.push({ ...msg, content: cleanedText });

    let executedAnyTool = false;

    if (msg.tool_calls?.length) {
      executedAnyTool = true;
      for (const call of msg.tool_calls) {
        let args: any = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* ignore */
        }
        const {
          result,
          pixBlock: pb,
          pixKeyLabel: pkl,
          pixKeyMessage: pkm,
        } = await executeTool(call.function.name, args, {
          supabaseAdmin: opts.supabaseAdmin,
          conversation: opts.conversation,
          draft: opts.draft,
          flags,
          finalConfirmationAllowed,
          bairrosAtendidos: opts.bairrosAtendidos,
          bairrosNaoAtendidos: opts.bairrosNaoAtendidos,
          ruasNaoAtendidas: opts.ruasNaoAtendidas,
        });
        if (pb) pixBlock = pb;
        if (pkl) pixKeyLabel = pkl;
        if (pkm) pixKeyMessage = pkm;
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        if (flags.silenced)
          return {
            silenced: true,
            finalText: "",
            pixBlock: null,
            pixKeyLabel: null,
            pixKeyMessage: null,
          };
      }
    }

    if (inlineCalls.length) {
      executedAnyTool = true;
      for (const inline of inlineCalls) {
        const {
          result,
          pixBlock: pb,
          pixKeyLabel: pkl,
          pixKeyMessage: pkm,
        } = await executeTool(inline.name, inline.args, {
          supabaseAdmin: opts.supabaseAdmin,
          conversation: opts.conversation,
          draft: opts.draft,
          flags,
          finalConfirmationAllowed,
          bairrosAtendidos: opts.bairrosAtendidos,
          bairrosNaoAtendidos: opts.bairrosNaoAtendidos,
          ruasNaoAtendidas: opts.ruasNaoAtendidas,
        });
        if (pb) pixBlock = pb;
        if (pkl) pixKeyLabel = pkl;
        if (pkm) pixKeyMessage = pkm;
        // Não existe tool_call_id de verdade pra essas (o modelo não usou o
        // formato estruturado), então avisa o resultado como uma mensagem de
        // sistema — o suficiente pra próxima rodada saber o que aconteceu.
        messages.push({
          role: "system",
          content: `[resultado de ${inline.name}] ${JSON.stringify(result)}`,
        });
        if (flags.silenced)
          return {
            silenced: true,
            finalText: "",
            pixBlock: null,
            pixKeyLabel: null,
            pixKeyMessage: null,
          };
      }
    }

    if (executedAnyTool) {
      // Se a rodada só tinha chamada(s) de ferramenta (com ou sem texto
      // sobrando contaminado), força uma rodada nova pra gerar uma resposta
      // limpa em vez de confiar no texto que veio junto da chamada crua.
      continue;
    }

    finalText = cleanedText;
    break;
  }

  // Se os rounds acabaram e o modelo ficou só chamando ferramentas sem nunca
  // devolver texto (loop de tool calls), finalText continua vazio aqui. Em vez
  // de cair direto no fallback genérico — que se repetiria em TODA mensagem
  // enquanto esse padrão persistir — força uma última chamada SEM ferramentas
  // (tool_choice: "none") pra garantir uma resposta real com o que já foi
  // apurado até aqui.
  if (!finalText) {
    const forced = await callChatCompletion(opts.supabaseAdmin, {
      messages,
      tools: TOOLS,
      tool_choice: "none",
    });
    const forcedMsg = forced?.choices?.[0]?.message;
    const { cleanedText: forcedCleanedText } = extractInlineFunctionCalls(forcedMsg?.content);
    if (forcedCleanedText) {
      finalText = forcedCleanedText;
    } else {
      try {
        await opts.supabaseAdmin.rpc("record_system_alert", {
          _kind: "ia_loop_ferramentas",
          _message:
            "A IA ficou vários rounds seguidos só chamando ferramentas sem gerar uma resposta em texto pro cliente. Vale revisar o prompt ou o modelo em uso.",
          _severity: "warn",
        });
      } catch {
        /* alerta não pode quebrar o fluxo */
      }
    }
  }

  return {
    finalText: enforceApprovedFreight(finalText, opts.draft),
    pixBlock,
    pixKeyLabel,
    pixKeyMessage,
    sendMenuImage: flags.sendMenuImage ?? false,
  };
}

// ============================================================
// Handler principal
// ============================================================

export const Route = createFileRoute("/api/public/webhooks/evolution")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let payload: any;
        try {
          payload = await request.json();
        } catch {
          return new Response("bad json", { status: 400 });
        }

        // O webhook da Meta reaproveita esse endpoint internamente (repassa a
        // mensagem já traduzida pra cá, pra usar a mesma lógica de IA/pedido).
        // Esse cabeçalho identifica esse caso — importante porque o botão de
        // desligar a Evolution por completo NÃO pode bloquear o canal da Meta,
        // mesmo as duas passando pelo mesmo código de processamento.
        const isFromMeta = request.headers.get("x-forwarded-provider") === "meta";

        try {
          return await handleIncomingMessage(payload, { skipEvolutionKillSwitch: isFromMeta });
        } catch (err: any) {
          console.error("[evolution webhook] erro não tratado:", err);
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const { logApi } = await import("@/lib/api-log.server");
            await logApi(supabaseAdmin, {
              source: "evolution_webhook",
              direction: "in",
              request_payload: payload,
              response_status: 500,
              error_message: String(err?.message ?? err),
            });
            await supabaseAdmin.rpc("record_system_alert", {
              _kind: "evolution_webhook_error",
              _message: `Webhook Evolution falhou: ${String(err?.message ?? err).slice(0, 400)}`,
              _context: { stack: String(err?.stack ?? "").slice(0, 1000) },
              _severity: "error",
            });
          } catch {
            /* nunca deixa o log/alerta quebrar a resposta */
          }
          return Response.json(
            { ok: false, error: String(err?.message ?? err), stack: String(err?.stack ?? "") },
            { status: 500 },
          );
        }
      },
    },
  },
});

async function handleIncomingMessageUnlocked(
  payload: any,
  opts?: {
    skipEvolutionKillSwitch?: boolean;
    preloggedConversation?: any;
    preloggedText?: string;
    skipTextLog?: boolean;
  },
): Promise<Response> {
  const event = String(payload?.event ?? payload?.type ?? "").toLowerCase();

  // aceita qualquer evento de mensagem — filtra o que não é mensagem nova dentro
  if (!event.includes("message")) {
    console.log("[evolution webhook] evento ignorado:", event);
    return Response.json({ ignored: true, event });
  }

  // Botão de emergência (Configurações → WhatsApp): com a Evolution
  // desabilitada, o sistema ignora QUALQUER coisa que chegue por esse
  // webhook — mesmo que a instância continue rodando e mandando eventos.
  // Isso é intencional e separado do seletor de provedor: dá pra desligar
  // a Evolution por completo sem precisar reconfigurar nada. NÃO se aplica
  // quando a chamada é o encaminhamento interno do webhook da Meta.
  if (!opts?.skipEvolutionKillSwitch) {
    const { supabaseAdmin: sb } = await import("@/integrations/supabase/client.server");
    const { isEvolutionDisabled } = await import("@/lib/whatsapp-send.server");
    if (await isEvolutionDisabled(sb)) {
      return Response.json({ ignored: "evolution_disabled" });
    }
  }

  // ============ CONFIRMAÇÃO DE LEITURA ============
  // Evento de status da mensagem (entregue/lida/tocada). "READ" e "PLAYED"
  // (áudio ouvido) contam como "o cliente leu" — casa pelo ID da mensagem
  // (guardado em external_id quando a mensagem foi enviada) e marca
  // read_at. DELIVERY_ACK/SERVER_ACK não significam leitura, só ignora.
  const msgStatus = String(payload?.data?.status ?? "").toUpperCase();
  if (["DELIVERY_ACK", "READ", "PLAYED", "SERVER_ACK"].includes(msgStatus)) {
    if (msgStatus === "READ" || msgStatus === "PLAYED") {
      const externalId: string | undefined = payload?.data?.key?.id;
      if (externalId) {
        try {
          const { supabaseAdmin: sb } = await import("@/integrations/supabase/client.server");
          await sb
            .from("whatsapp_messages")
            .update({ read_at: new Date().toISOString() })
            .eq("external_id", externalId)
            .is("read_at", null);
        } catch (err) {
          console.error("[evolution webhook] falha ao gravar confirmação de leitura:", err);
        }
      }
    }
    return Response.json({ ignored: "delivery_ack" });
  }

  // A Evolution API varia o formato conforme a versão: às vezes "data" já é o
  // objeto da mensagem (key/message direto), às vezes vem cru do Baileys como
  // { messages: [ {...} ], type: "notify" }. Aceitamos os dois formatos.
  const rawData = payload?.data ?? payload?.message ?? payload;
  const data = Array.isArray(rawData?.messages) ? rawData.messages[0] : rawData;
  if (!data) return Response.json({ ignored: "empty_payload" });

  const fromMe = data?.key?.fromMe;
  if (fromMe) return Response.json({ ignored: "from_me" });

  const remoteJid: string = data?.key?.remoteJid ?? "";
  if (!remoteJid || remoteJid.endsWith("@g.us")) return Response.json({ ignored: "group_or_empty" });
  const phone = remoteJid.split("@")[0].replace(/\D/g, "");
  const pushName: string = data?.pushName ?? "";

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const conversation = opts?.preloggedConversation ?? await getOrCreateConversation(supabaseAdmin, phone, pushName);

  // Interruptor global do atendimento automático (Configurações → WhatsApp).
  // Desligado, a IA não responde NENHUMA conversa — igual a "pausado" pra
  // todo mundo — mas as mensagens continuam chegando no chat normalmente.
  const { data: botToggle } = await supabaseAdmin.from("store_config").select("bot_global_active").maybeSingle();
  const botGloballyOff = botToggle?.bot_global_active === false;

  // ============ IMAGEM (inclui comprovante Pix) ============
  const imageMsg = data?.message?.imageMessage;
  const base64Image: string | undefined = data?.message?.base64 ?? imageMsg?.base64 ?? payload?.data?.message?.base64;
  if (imageMsg && base64Image) {
    const mimeType = imageMsg.mimetype || "image/jpeg";
    // Faz upload para o Supabase Storage para exibir no painel do chat
    const imageMediaUrl = await uploadMediaToStorage(
      supabaseAdmin, base64Image, mimeType, conversation.id,
    );
    await logMessage(supabaseAdmin, conversation.id, {
      direction: "in",
      sender_type: "customer",
      body: imageMsg.caption || null,
      media_type: "image",
      media_url: imageMediaUrl,
    });
    if (!conversation.bot_paused && !botGloballyOff) {
      await handleReceiptImage(supabaseAdmin, conversation.id, phone, base64Image, mimeType);
    }
    return Response.json({ ok: true, action: "image_received" });
  }

  // ============ DOCUMENTO / PDF ============
  const documentMsg = data?.message?.documentMessage;
  const base64Document: string | undefined = data?.message?.base64 ?? documentMsg?.base64;
  if (documentMsg && base64Document) {
    const mimeType = documentMsg.mimetype || "application/octet-stream";
    const fileName = documentMsg.fileName || documentMsg.title || undefined;
    const docMediaUrl = await uploadMediaToStorage(
      supabaseAdmin, base64Document, mimeType, conversation.id, fileName,
    );
    await logMessage(supabaseAdmin, conversation.id, {
      direction: "in",
      sender_type: "customer",
      body: documentMsg.caption || documentMsg.fileName || null,
      media_type: "document",
      media_url: docMediaUrl,
    });
    return Response.json({ ok: true, action: "document_received" });
  }

  // ============ ÁUDIO (mensagem de voz ou arquivo de áudio) ============
  const audioMsg = data?.message?.audioMessage ?? data?.message?.pttMessage;
  const base64Audio: string | undefined = data?.message?.base64 ?? audioMsg?.base64;
  if (audioMsg && base64Audio) {
    const mimeType = audioMsg.mimetype || "audio/ogg; codecs=opus";
    const audioMediaUrl = await uploadMediaToStorage(
      supabaseAdmin, base64Audio, mimeType, conversation.id,
    );
    await logMessage(supabaseAdmin, conversation.id, {
      direction: "in",
      sender_type: "customer",
      body: null,
      media_type: "audio",
      media_url: audioMediaUrl,
    });
    if (!conversation.bot_paused && !botGloballyOff) {
      await replyAndLog(
        supabaseAdmin,
        conversation.id,
        phone,
        "Para eu conseguir registrar seu atendimento corretamente, por favor escreva sua mensagem aqui no WhatsApp.",
      );
    }
    return Response.json({ ok: true, action: "audio_received" });
  }

  // ============ LOCALIZAÇÃO ============
  const locationMsg = data?.message?.locationMessage;
  if (locationMsg) {
    const lat = Number(locationMsg.degreesLatitude);
    const lng = Number(locationMsg.degreesLongitude);
    await logMessage(supabaseAdmin, conversation.id, {
      direction: "in",
      sender_type: "customer",
      body: Number.isFinite(lat) && Number.isFinite(lng) ? `Localização compartilhada: ${lat}, ${lng}` : "Localização compartilhada",
      media_type: "location",
    });
    if (!conversation.bot_paused && !botGloballyOff) {
      await replyAndLog(
        supabaseAdmin,
        conversation.id,
        phone,
        "Recebi sua localização. Para registrar a entrega corretamente, escreva por favor a rua, o número e o bairro.",
      );
    }
    return Response.json({ ok: true, action: "location_received" });
  }

  // ============ VÍDEO ============
  const videoMsg = data?.message?.videoMessage;
  const base64Video: string | undefined = data?.message?.base64 ?? videoMsg?.base64;
  if (videoMsg && base64Video) {
    const mimeType = videoMsg.mimetype || "video/mp4";
    const videoMediaUrl = await uploadMediaToStorage(
      supabaseAdmin, base64Video, mimeType, conversation.id,
    );
    await logMessage(supabaseAdmin, conversation.id, {
      direction: "in",
      sender_type: "customer",
      body: videoMsg.caption || null,
      media_type: "video",
      media_url: videoMediaUrl,
    });
    return Response.json({ ok: true, action: "video_received" });
  }

  let text: string = opts?.preloggedText ?? (
    data?.message?.conversation ??
    data?.message?.extendedTextMessage?.text ??
    data?.message?.ephemeralMessage?.message?.conversation ??
    data?.message?.ephemeralMessage?.message?.extendedTextMessage?.text ??
    data?.message?.text ??
    ""
  );

  if (!text.trim()) {
    // Tipo de mídia não reconhecido (figurinha, localização, reação, etc.)
    // — só registra para aparecer no histórico sem travar o fluxo
    await logMessage(supabaseAdmin, conversation.id, {
      direction: "in",
      sender_type: "customer",
      body: null,
      media_type: "document",
    });
    return Response.json({ ignored: "unsupported_media_type" });
  }

  if (!opts?.skipTextLog) {
    await logMessage(supabaseAdmin, conversation.id, {
      direction: "in",
      sender_type: "customer",
      body: text,
      external_id: data?.key?.id ?? null,
    });
  }

  // Admin assumiu essa conversa manualmente, ou o atendimento automático está
  // desligado globalmente — em ambos os casos não responde automaticamente.
  if (conversation.bot_paused || botGloballyOff) {
    return Response.json({
      ok: true,
      action: botGloballyOff ? "bot_globally_off" : "bot_paused_skipped",
    });
  }

  // Horário de atendimento (Configurações → Horário de atendimento). Se
  // ativado e a mensagem chegar fora dos dias/horas configurados, avisa que
  // a loja está fechada (citando os dias e horários certos) e NÃO processa
  // pedido nenhum — a IA só volta a responder normalmente dentro do horário.
  const { data: hoursCfg, error: hoursCfgError } = await supabaseAdmin
    .from("store_config")
    .select("business_hours_enabled, business_hours, business_hours_closed_message")
    .maybeSingle();
  if (hoursCfgError) {
    // Se a consulta falhar (ex: migration do horário de atendimento ainda
    // não rodou no banco e as colunas não existem), isso NUNCA pode passar
    // em silêncio — sem esse log, o sintoma é exatamente "configurei o
    // horário mas a IA responde normal fora de hora", sem pista nenhuma do
    // motivo. Loga e registra um alerta visível pra loja investigar.
    console.error("[business-hours] falha ao consultar store_config:", hoursCfgError.message);
    try {
      await supabaseAdmin.rpc("record_system_alert", {
        _kind: "horario_atendimento_falhou",
        _message: `Não foi possível checar o horário de atendimento configurado (erro: ${hoursCfgError.message}). Confira se a migration de horário de atendimento foi aplicada no banco.`,
        _severity: "error",
      });
    } catch {
      /* alerta não pode quebrar o fluxo */
    }
  }
  if (hoursCfg?.business_hours_enabled && Array.isArray(hoursCfg.business_hours) && hoursCfg.business_hours.length) {
    const withinHours = isWithinBusinessHours(hoursCfg.business_hours as BusinessHourRange[], new Date());
    if (!withinHours) {
      const closedMessage =
        (hoursCfg.business_hours_closed_message as string | null)?.trim() ||
        `Olá, obrigado pelo seu contato! Nossos dias e horários de funcionamento são: ${formatBusinessHoursText(
          hoursCfg.business_hours as BusinessHourRange[],
        )}. Assim que abrirmos, respondemos por aqui.`;
      // Evita mandar o aviso de "fechado" repetidas vezes seguidas pro mesmo
      // cliente — só manda de novo se a última mensagem de saída não foi
      // esse mesmo aviso (ex: cliente manda 3 mensagens seguidas fora de hora).
      const { data: lastOut } = await supabaseAdmin
        .from("whatsapp_messages")
        .select("body, media_type")
        .eq("conversation_id", conversation.id)
        .eq("direction", "out")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const alreadyWarned = lastOut?.media_type === "system" && lastOut?.body === closedMessage;
      if (!alreadyWarned) {
        await replyAndLog(supabaseAdmin, conversation.id, phone, closedMessage, {
          systemMessage: true,
        });
      }
      return Response.json({ ok: true, action: "outside_business_hours" });
    }
  }

  const { data: cfgStore } = await supabaseAdmin
    .from("store_config")
    .select(
      "store_name, default_delivery_fee, estimated_delivery_time_minutes, delivery_pricing_mode, delivery_fee_tiers, business_hours_enabled, business_hours, ifood_store_link, nfood_store_link, ai_temperature",
    )
    .maybeSingle();
  const businessHoursText =
    cfgStore?.business_hours_enabled && Array.isArray(cfgStore?.business_hours) && cfgStore.business_hours.length
      ? formatBusinessHoursText(cfgStore.business_hours as BusinessHourRange[])
      : null;
  const maxRadiusKm =
    cfgStore?.delivery_pricing_mode === "distance" &&
    Array.isArray(cfgStore?.delivery_fee_tiers) &&
    cfgStore.delivery_fee_tiers.length
      ? Math.max(...cfgStore.delivery_fee_tiers.map((t: any) => Number(t.km_to) || 0))
      : null;
  // Links da loja no iFood/99Food (Configurações → Integrações), usados pelo
  // fluxo de REDIRECIONAMENTO FORA DE ÁREA — quando o entregador fixo do
  // WhatsApp não atende o endereço do cliente, a IA oferece esses links em
  // vez de simplesmente recusar a entrega.
  const outOfAreaLinksText = buildOutOfAreaLinksText(
    cfgStore?.ifood_store_link || null,
    cfgStore?.nfood_store_link || null,
  );
  const { catalogText, unavailableText, categoriesText } = await loadCatalogText(supabaseAdmin);
  const draft = await loadOrCreateDraft(supabaseAdmin, conversation.id);
  const lastOrderText = await loadLastOrderText(supabaseAdmin, phone);
  const lastAddressText = await loadLastAddressText(supabaseAdmin, phone);

  // carrega instruções ativas da IA — globais + as do dia de hoje (fuso Brasília)
  // resiliente: se a tabela ainda não existir no banco, ignora e continua
  let aiInstructionsText: string | null = null;
  try {
    const todayBR = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const { data: aiInstructions } = await supabaseAdmin
      .from("ai_instructions")
      .select("type, content, valid_date")
      .eq("active", true)
      .or(`type.eq.global,and(type.eq.daily,valid_date.eq.${todayBR})`);
    aiInstructionsText =
      (aiInstructions ?? []).length > 0
        ? (aiInstructions ?? [])
            .map((i: any) => `- [${i.type === "daily" ? "INSTRUÇÃO DO DIA" : "INSTRUÇÃO GERAL"}] ${i.content}`)
            .join("\n")
        : null;
  } catch {
    // tabela ai_instructions ainda não existe — continua sem instruções extras
  }

  // carrega a lista oficial de bairros atendidos (Configurações → Bairros
  // atendidos) — quando existe pelo menos 1 bairro ativo, ela vira a fonte
  // de verdade sobre área de entrega, veja applyBairroOverride().
  let bairrosAtendidos: string[] = [];
  let bairrosAtendidosText: string | null = null;
  try {
    const { data: bairrosRows } = await (supabaseAdmin as any)
      .from("bairros_atendidos")
      .select("nome")
      .eq("ativo", true);
    bairrosAtendidos = (bairrosRows ?? []).map((r: any) => String(r.nome)).filter(Boolean);
    bairrosAtendidosText = bairrosAtendidos.length ? bairrosAtendidos.join(", ") : null;
  } catch {
    // tabela bairros_atendidos ainda não existe — continua sem a lista estruturada
  }

  // carrega a lista de BAIRROS NÃO ATENDIDOS (Configurações → Bairros não
  // atendidos) — bloqueio explícito, checado em código com prioridade máxima
  // (antes até da lista de bairros atendidos), ver applyBairroOverride().
  let bairrosNaoAtendidos: string[] = [];
  let bairrosNaoAtendidosText: string | null = null;
  try {
    const { data: bairrosNaoAtendidosRows } = await (supabaseAdmin as any)
      .from("bairros_nao_atendidos")
      .select("nome")
      .eq("ativo", true);
    bairrosNaoAtendidos = (bairrosNaoAtendidosRows ?? []).map((r: any) => String(r.nome)).filter(Boolean);
    bairrosNaoAtendidosText = bairrosNaoAtendidos.length ? bairrosNaoAtendidos.join(", ") : null;
  } catch {
    // tabela bairros_nao_atendidos ainda não existe — continua sem a lista estruturada
  }

  // carrega a lista de RUAS NÃO ATENDIDAS (Configurações → Ruas não
  // atendidas) — mesmo princípio da lista de bairros não atendidos, mas por
  // rua específica (útil quando só um trecho/rua do bairro não é atendido).
  let ruasNaoAtendidas: string[] = [];
  let ruasNaoAtendidasText: string | null = null;
  try {
    const { data: ruasNaoAtendidasRows } = await (supabaseAdmin as any)
      .from("ruas_nao_atendidas")
      .select("nome, bairro")
      .eq("ativo", true);
    ruasNaoAtendidas = (ruasNaoAtendidasRows ?? []).map((r: any) => String(r.nome)).filter(Boolean);
    ruasNaoAtendidasText = (ruasNaoAtendidasRows ?? []).length
      ? (ruasNaoAtendidasRows ?? [])
          .map((r: any) => (r.bairro ? `${r.nome} (${r.bairro})` : String(r.nome)))
          .filter(Boolean)
          .join(", ")
      : null;
  } catch {
    // tabela ruas_nao_atendidas ainda não existe — continua sem a lista estruturada
  }

  const { data: recentMessages } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("direction, sender_type, body, media_type, created_at")
    .eq("conversation_id", conversation.id)
    .not("body", "is", null)
    .order("created_at", { ascending: false })
    .limit(60);
  const history = (recentMessages ?? [])
    .filter((m: any) => {
      // fora do histórico da IA: mensagens marcadas como "system" (comprovante,
      // título/chave Pix, fallback) e — guarda retroativa pra linhas antigas do
      // banco gravadas antes dessa marcação existir
      if (m.media_type === "system") return false;
      const b = String(m.body ?? "");
      if (m.direction === "out" && (b.startsWith("📋 Pedido") || b.startsWith("🔑"))) return false;
      return true;
    })
    .reverse()
    .slice(-40)
    .map((m: any) => ({
      role: m.direction === "in" ? "user" : "assistant",
      // Mensagens enviadas manualmente pelo operador fazem parte do contexto
      // oficial da conversa. A IA deve continuar dali sem contradizer nem
      // reiniciar o atendimento quando o bot for reativado.
      content: m.direction === "out" && m.sender_type === "admin"
        ? `[ATENDENTE HUMANO DA LOJA] ${m.body ?? ""}`
        : (m.body ?? ""),
    }));

  // ============ CAPTURA DETERMINÍSTICA DE PAGAMENTO ============
  // Forma/momento de pagamento são dados transacionais; não dependem da memória
  // probabilística da IA. Interpreta o turno do cliente com o contexto da pergunta
  // anterior e persiste antes de qualquer nova decisão do modelo.
  const deterministicPayment = inferPaymentFromCustomerTurn(text, history, draft);
  if (deterministicPayment) {
    await persistDeterministicPayment(supabaseAdmin, conversation.id, draft, deterministicPayment);
  }

  // ============ CARDÁPIO RESPEITA O CANAL DEFINIDO PELO BAIRRO ============
  // Não existe mais atalho de cardápio antes da validação do bairro. Para entrega,
  // primeiro identificamos o bairro: atendido => cardápio/preços do WhatsApp;
  // externo => plataformas, sem expor o cardápio/preços do WhatsApp. Retirada é exceção.

  // ============ PORTÃO DETERMINÍSTICO DE BAIRRO ============
  // Para decisões de entrega, preço/promoção, cardápio e continuidade do pedido,
  // o bairro precisa ser validado. Bairro atendido segue pelo WhatsApp; bairro
  // externo segue pelas plataformas. Retirada não exige bairro.
  if (bairrosAtendidos.length > 0 && draft.delivery_mode !== "pickup") {
    if (looksLikePickupIntent(text)) {
      draft.delivery_mode = "pickup";
      draft.out_of_delivery_area = false;
      await supabaseAdmin
        .from("order_drafts")
        .update({ delivery_mode: "pickup", out_of_delivery_area: false, updated_at: new Date().toISOString() })
        .eq("conversation_id", conversation.id);
    } else if (!draft.address_neighborhood) {
      const previousAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
      const awaitingNeighborhood = /bairro/i.test(previousAssistant) && /(informe|qual|diga)/i.test(previousAssistant);
      const pendingSpecial = pendingSpecialNeighborhoodFromHistory(history);
      if (pendingSpecial) {
        const special = specialNeighborhoodDecision(pendingSpecial, text);
        if (special === "allow") {
          draft.delivery_mode = "delivery";
          draft.address_neighborhood = pendingSpecial;
          draft.out_of_delivery_area = false;
          await supabaseAdmin
            .from("order_drafts")
            .update({
              delivery_mode: "delivery",
              address_neighborhood: pendingSpecial,
              out_of_delivery_area: false,
              updated_at: new Date().toISOString(),
            })
            .eq("conversation_id", conversation.id);
          await replyAndLog(supabaseAdmin, conversation.id, phone, "Obrigado pela informação! Em que posso ajudar? Gostaria de ver nosso cardápio?");
          return Response.json({ ok: true, action: "special_neighborhood_accepted" });
        }
        if (special === "redirect") {
          await replyAndLog(
            supabaseAdmin,
            conversation.id,
            phone,
            formatOutOfAreaDirectReply(cfgStore?.ifood_store_link || null, cfgStore?.nfood_store_link || null),
          );
          return Response.json({ ok: true, action: "special_neighborhood_redirect" });
        }
        const q = specialNeighborhoodQuestion(pendingSpecial);
        if (q) {
          await replyAndLog(supabaseAdmin, conversation.id, phone, q);
          return Response.json({ ok: true, action: "special_neighborhood_detail_required" });
        }
      }

      const pendingNeighborhoodConfirmation = pendingNeighborhoodConfirmationFromHistory(history);
      let candidate = extractNeighborhoodCandidate(
        text,
        [...bairrosAtendidos, ...bairrosNaoAtendidos],
        awaitingNeighborhood,
      );

      // Se acabamos de pedir confirmação de um nome de bairro desconhecido e
      // o cliente respondeu "sim", agora sim esse nome passa a ser confiável.
      // Se respondeu "não", voltamos a pedir o bairro em vez de redirecionar.
      if (pendingNeighborhoodConfirmation && isExplicitOrderConfirmation(text)) {
        const best = bestKnownLocality(
          pendingNeighborhoodConfirmation,
          allKnownDuqueLocalities([...bairrosAtendidos, ...bairrosNaoAtendidos]),
        );
        candidate = best && best.score >= 0.86 ? { value: best.value, source: "known" } : null;
        if (!candidate) {
          await replyAndLog(
            supabaseAdmin,
            conversation.id,
            phone,
            "Para evitar te direcionar para o lugar errado, preciso do nome exato do seu bairro em Duque de Caxias. Pode me informar, por favor?",
          );
          return Response.json({ ok: true, action: "neighborhood_exact_name_required" });
        }
      } else if (pendingNeighborhoodConfirmation && isExplicitNegative(text)) {
        await replyAndLog(supabaseAdmin, conversation.id, phone, "Sem problema. Por favor, informe somente o nome do seu bairro para eu verificar o atendimento corretamente.");
        return Response.json({ ok: true, action: "neighborhood_required_after_correction" });
      }

      if (!candidate) {
        const hasPreviousAssistant = history.some((m) => m.role === "assistant");
        const ask = hasPreviousAssistant
          ? "Antes de continuar, informe seu bairro por favor."
          : `${greetingByTimeBR()}! Para que o atendente possa dar continuidade no seu atendimento, informe seu bairro por favor.`;
        await replyAndLog(supabaseAdmin, conversation.id, phone, ask);
        return Response.json({ ok: true, action: "neighborhood_required" });
      }

      const candidateValue = candidate.value;
      const special = specialNeighborhoodDecision(candidateValue, text);
      if (special === "ask") {
        const q = specialNeighborhoodQuestion(candidateValue);
        if (q) {
          await replyAndLog(supabaseAdmin, conversation.id, phone, q);
          return Response.json({ ok: true, action: "special_neighborhood_detail_required" });
        }
      }
      if (special === "redirect") {
        await replyAndLog(
          supabaseAdmin,
          conversation.id,
          phone,
          formatOutOfAreaDirectReply(cfgStore?.ifood_store_link || null, cfgStore?.nfood_store_link || null),
        );
        return Response.json({ ok: true, action: "special_neighborhood_redirect" });
      }

      const attendedMatch = findConfiguredBairroMatch(candidateValue, bairrosAtendidos);
      // Lista positiva ativa vence qualquer cadastro negativo antigo/duplicado.
      const blockedMatch = attendedMatch ? null : findConfiguredBairroMatch(candidateValue, bairrosNaoAtendidos);
      const blocked = !!blockedMatch;
      const attended = special === "allow" || !!attendedMatch;
      const isKnown = blocked || attended;
      // Quando houve match na lista ATIVA, salva a própria grafia cadastrada no
      // painel. Isso impede que um alias municipal fique gravado como se fosse
      // outro bairro e garante consistência nas próximas rodadas.
      const resolvedCandidateValue = attendedMatch || blockedMatch || candidateValue;

      // REGRA DE SEGURANÇA: "não reconhecido" nunca significa "fora da área".
      // Só uma localidade comprovadamente reconhecida pode seguir para a decisão
      // entrega própria x plataformas. Isso impede frases aleatórias de virarem
      // bairros externos e causarem perda de venda.
      const recognizedMunicipalityLocality = candidate.source === "known" || isKnown;
      if (!recognizedMunicipalityLocality) {
        await replyAndLog(
          supabaseAdmin,
          conversation.id,
          phone,
          "Não consegui identificar esse nome como um bairro/localidade de Duque de Caxias. Pode conferir e me informar somente o nome do bairro, por favor?",
        );
        return Response.json({ ok: true, action: "neighborhood_not_recognized" });
      }

      draft.delivery_mode = "delivery";
      draft.address_neighborhood = resolvedCandidateValue;
      draft.out_of_delivery_area = !attended;
      await supabaseAdmin
        .from("order_drafts")
        .update({
          delivery_mode: "delivery",
          address_neighborhood: resolvedCandidateValue,
          out_of_delivery_area: !attended,
          updated_at: new Date().toISOString(),
        })
        .eq("conversation_id", conversation.id);

      if (!attended) {
        await replyAndLog(
          supabaseAdmin,
          conversation.id,
          phone,
          formatOutOfAreaDirectReply(cfgStore?.ifood_store_link || null, cfgStore?.nfood_store_link || null),
        );
        return Response.json({ ok: true, action: "redirect_platforms_by_neighborhood" });
      }

      // Se a mensagem foi apenas a resposta do bairro, não desperdiça uma
      // chamada de IA: confirma a cobertura e abre espaço para o cliente dizer
      // o que deseja. Se ele já incluiu outra pergunta na mesma mensagem, segue
      // para a IA agora que o bairro está validado.
      const normalized = normalizeStreet(text);
      const onlyNeighborhood = similarity(normalizeNeighborhoodKey(text), normalizeNeighborhoodKey(resolvedCandidateValue)) >= 0.9 && normalizeNeighborhoodKey(text).length <= normalizeNeighborhoodKey(resolvedCandidateValue).length + 8;
      if (onlyNeighborhood) {
        await replyAndLog(
          supabaseAdmin,
          conversation.id,
          phone,
          "Obrigado pela informação! Em que posso ajudar? Gostaria de ver nosso cardápio?",
        );
        return Response.json({ ok: true, action: "neighborhood_accepted" });
      }
    } else if (draft.out_of_delivery_area) {
      // O cliente pode corrigir o bairro depois de uma informação anterior.
      // Nunca "prendemos" a conversa no redirecionamento: se ele informar um
      // bairro atendido agora, recuperamos a venda e seguimos pelo WhatsApp.
      const correction = extractNeighborhoodCandidate(
        text,
        [...bairrosAtendidos, ...bairrosNaoAtendidos],
        true,
      );
      const correctedAttended = correction ? findConfiguredBairroMatch(correction.value, bairrosAtendidos) : null;
      // Se está na lista positiva ativa, recupera a conversa imediatamente,
      // mesmo que exista lixo/duplicidade antiga na tabela negativa.
      if (correction && correctedAttended) {
        draft.address_neighborhood = correctedAttended;
        draft.out_of_delivery_area = false;
        await supabaseAdmin
          .from("order_drafts")
          .update({
            address_neighborhood: correctedAttended,
            out_of_delivery_area: false,
            updated_at: new Date().toISOString(),
          })
          .eq("conversation_id", conversation.id);
        await replyAndLog(
          supabaseAdmin,
          conversation.id,
          phone,
          "Obrigado pela informação! Em que posso ajudar? Gostaria de ver nosso cardápio?",
        );
        return Response.json({ ok: true, action: "neighborhood_corrected_to_attended" });
      }

      await replyAndLog(
        supabaseAdmin,
        conversation.id,
        phone,
        formatOutOfAreaDirectReply(cfgStore?.ifood_store_link || null, cfgStore?.nfood_store_link || null),
      );
      return Response.json({ ok: true, action: "redirect_platforms_existing_neighborhood" });
    }
  }

  // Saudação pura ("bom dia", "oi", etc, sozinha) NUNCA pode acionar nenhuma
  // ferramenta nesta rodada — nem update_order_draft, nem finalize_order —
  // não importa o que já esteja salvo no rascunho dessa conversa. Isso é o
  // que impede a IA de "fechar pedido sozinha" em cima de dado antigo quando
  // o cliente só deu um oi.
  const forceNoTools = isPureGreeting(text);

  // ============ ATALHO DETERMINÍSTICO PRO PRIMEIRO CONTATO ============
  // Quando o cliente manda só uma saudação pura ("oi", "bom dia"...) NO
  // PRIMEIRO CONTATO da conversa, a resposta NÃO passa pela IA — é montada
  // aqui, em código, sempre igual: cumprimento + pergunta curta de como
  // ajudar. Depender só da instrução no prompt ("não despeje o cardápio
  // inteiro numa saudação") é frágil — o modelo pode ignorá-la, como
  // aconteceu de fato em produção (cliente mandou "boa tarde" e a IA
  // respondeu com a loja inteira de categorias e preços). Com esse atalho,
  // uma saudação pura no primeiro contato é estruturalmente impossível de
  // virar um despejo de cardápio: o código nunca chama o modelo pra essa
  // resposta, então não existe texto pra ele gerar errado.
  // OBS: a imagem do cardápio NÃO é mais enviada aqui — só quando o cliente
  // pedir (ver ferramenta send_menu_image).
  const assistantTurnsSoFar = history.filter((m) => m.role === "assistant").length;
  const isFirstContactTurn = assistantTurnsSoFar === 0;
  if (forceNoTools && isFirstContactTurn) {
    const storeNameForGreeting = cfgStore?.store_name || "a loja";
    const greetingText = `${greetingByTimeBR()}! Para que o atendente possa dar continuidade no seu atendimento, informe seu bairro por favor.`;
    await replyAndLog(supabaseAdmin, conversation.id, phone, greetingText);
    return Response.json({ ok: true, action: "conversation_turn" });
  }

  const { silenced, finalText, pixBlock, pixKeyLabel, pixKeyMessage, sendMenuImage } = await runConversationalTurn({
    supabaseAdmin,
    conversation,
    draft,
    history,
    storeName: cfgStore?.store_name || "a loja",
    catalogText,
    unavailableText,
    categoriesText,
    pushName,
    pricingMode: cfgStore?.delivery_pricing_mode || "flat",
    maxRadiusKm,
    flatFee: Number(cfgStore?.default_delivery_fee ?? 0),
    deliveryTimeMinutes: cfgStore?.estimated_delivery_time_minutes ?? null,
    lastOrderText,
    lastAddressText,
    aiInstructionsText,
    bairrosAtendidos,
    bairrosAtendidosText,
    bairrosNaoAtendidos,
    bairrosNaoAtendidosText,
    ruasNaoAtendidas,
    ruasNaoAtendidasText,
    forceNoTools,
    businessHoursText,
    outOfAreaLinksText,
  });

  // Gerente recusou a taxa de entrega calculada: a conversa passou pro modo
  // manual e a IA não manda nada — quem responde agora é a loja.
  if (silenced) {
    return Response.json({ ok: true, action: "freight_manual_takeover" });
  }

  if (finalText) {
    await replyAndLog(supabaseAdmin, conversation.id, phone, finalText);
  }
  // A imagem do cardápio só é enviada quando a IA chamou a ferramenta
  // send_menu_image nesta rodada (cliente pediu o cardápio ou perguntou
  // preço/valor de forma genérica) — nunca mais automaticamente no primeiro
  // contato. force=true porque, se a IA decidiu chamar a ferramenta, é
  // porque o cliente pediu — inclusive se for um reenvio.
  if (sendMenuImage) {
    await sendMenuImagesOnce(supabaseAdmin, conversation.id, phone, isExplicitMenuRequest(text));
  }
  if (pixBlock) {
    await replyAndLog(supabaseAdmin, conversation.id, phone, pixBlock, { systemMessage: true });
  }
  // Título da chave e a chave em si vão em DUAS mensagens separadas — assim o
  // cliente consegue segurar e copiar só o código, sem o texto "chave
  // aleatória" grudado junto (o WhatsApp copia a mensagem inteira).
  if (pixKeyLabel) {
    await replyAndLog(supabaseAdmin, conversation.id, phone, pixKeyLabel, { systemMessage: true });
  }
  if (pixKeyMessage) {
    await replyAndLog(supabaseAdmin, conversation.id, phone, pixKeyMessage, {
      systemMessage: true,
    });
  }
  if (!finalText && !pixBlock) {
    // Fallback só quando a IA realmente não gerou nada (ex: provedores fora do
    // ar). Marcado como system pra NUNCA entrar no histórico que a IA lê — o
    // fallback antigo entrava no histórico e alimentava o loop de repetição.
    await replyAndLog(
      supabaseAdmin,
      conversation.id,
      phone,
      `Tive uma instabilidade no atendimento e não consegui concluir sua mensagem agora. Se puder, envie novamente em instantes; se persistir, um atendente continuará por aqui.`,
      { systemMessage: true },
    );
  }

  return Response.json({ ok: true, action: "conversation_turn" });
}

export async function handleIncomingMessage(
  payload: any,
  opts?: { skipEvolutionKillSwitch?: boolean },
): Promise<Response> {
  const phone = extractPhoneFromEvolutionPayload(payload);
  if (!phone) return handleIncomingMessageUnlocked(payload, opts);

  const event = String(payload?.event ?? payload?.type ?? "").toLowerCase();
  const msgStatus = String(payload?.data?.status ?? "").toUpperCase();
  // Eventos de status/ack e eventos que não são mensagem continuam no caminho
  // original; nunca entram no debounce nem são gravados como fala do cliente.
  if (!event.includes("message") || ["DELIVERY_ACK", "READ", "PLAYED", "SERVER_ACK"].includes(msgStatus)) {
    return handleIncomingMessageUnlocked(payload, opts);
  }

  // Mantém o kill-switch da Evolution também na etapa de pré-ingestão.
  if (!opts?.skipEvolutionKillSwitch) {
    const { supabaseAdmin: sb } = await import("@/integrations/supabase/client.server");
    const { isEvolutionDisabled } = await import("@/lib/whatsapp-send.server");
    if (await isEvolutionDisabled(sb)) return Response.json({ ignored: "evolution_disabled" });
  }

  // Para mensagens de texto, fazemos a ingestão ANTES do lock e esperamos um
  // curto período de silêncio. Assim duas mensagens enviadas uma atrás da outra
  // entram juntas no histórico antes de a IA responder. Só um dos webhooks
  // processa o lote; os demais percebem que já houve resposta e encerram.
  const rawData = payload?.data ?? payload?.message ?? payload;
  const data = Array.isArray(rawData?.messages) ? rawData.messages[0] : rawData;
  const fromMe = data?.key?.fromMe;
  const remoteJid: string = data?.key?.remoteJid ?? "";
  const incomingText: string =
    data?.message?.conversation ??
    data?.message?.extendedTextMessage?.text ??
    data?.message?.ephemeralMessage?.message?.conversation ??
    data?.message?.ephemeralMessage?.message?.extendedTextMessage?.text ??
    data?.message?.text ??
    "";

  const isPlainText = Boolean(
    incomingText.trim() && !fromMe && remoteJid && !remoteJid.endsWith("@g.us"),
  );

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  if (isPlainText) {
    const pushName: string = data?.pushName ?? "";
    const conversation = await getOrCreateConversation(supabaseAdmin, phone, pushName);
    const externalId = data?.key?.id ?? null;

    // Deduplicação do webhook: se o provedor reenviar a mesma mensagem, ela não
    // entra duas vezes no histórico nem dispara uma segunda resposta/cardápio.
    if (externalId) {
      const { data: existing } = await supabaseAdmin
        .from("whatsapp_messages")
        .select("id")
        .eq("conversation_id", conversation.id)
        .eq("external_id", externalId)
        .maybeSingle();
      if (existing) return Response.json({ ok: true, action: "duplicate_message_ignored" });
    }

    await logMessage(supabaseAdmin, conversation.id, {
      direction: "in",
      sender_type: "customer",
      body: incomingText,
      external_id: externalId,
    });

    // Debounce humano: clientes frequentemente mandam 2 ou 3 mensagens em
    // sequência. Damos 1,2 s para elas chegarem antes de montar a resposta.
    await new Promise((r) => setTimeout(r, 1200));

    const locked = await acquireWhatsappProcessingLock(supabaseAdmin, phone);
    if (!locked) {
      console.warn(`[conversation-lock] timeout aguardando turno anterior de ${phone}`);
      return Response.json({ ok: true, action: "conversation_queued" });
    }

    try {
      const { data: pendingInbound } = await (supabaseAdmin as any)
        .from("whatsapp_messages")
        .select("id, body, created_at")
        .eq("conversation_id", conversation.id)
        .eq("direction", "in")
        .is("media_type", null)
        .is("ai_processed_at", null)
        .not("body", "is", null)
        .order("created_at", { ascending: true })
        .limit(10);

      if (!pendingInbound?.length) {
        // Outro webhook do mesmo lote já processou essas mensagens.
        return Response.json({ ok: true, action: "batched_message_already_answered" });
      }

      const batchIds = pendingInbound.map((m: any) => m.id).filter(Boolean);
      const combinedText = pendingInbound
        .map((m: any) => String(m.body ?? "").trim())
        .filter(Boolean)
        .join("\n");

      const response = await handleIncomingMessageUnlocked(payload, {
        ...opts,
        preloggedConversation: conversation,
        preloggedText: combinedText || incomingText,
        skipTextLog: true,
      });

      // Só marca como processado depois que o turno terminou com sucesso.
      // Mensagens que chegarem DURANTE a resposta não pertencem a batchIds e
      // continuam pendentes para o próximo turno — nunca somem silenciosamente.
      if (batchIds.length) {
        await (supabaseAdmin as any)
          .from("whatsapp_messages")
          .update({ ai_processed_at: new Date().toISOString() })
          .in("id", batchIds)
          .is("ai_processed_at", null);
      }
      return response;
    } finally {
      await releaseWhatsappProcessingLock(supabaseAdmin, phone);
    }
  }

  // Mídias/status continuam serializados pelo lock antigo.
  const locked = await acquireWhatsappProcessingLock(supabaseAdmin, phone);
  if (!locked) {
    console.warn(`[conversation-lock] timeout aguardando turno anterior de ${phone}`);
    return Response.json({ ok: true, action: "conversation_queued" });
  }
  try {
    return await handleIncomingMessageUnlocked(payload, opts);
  } finally {
    await releaseWhatsappProcessingLock(supabaseAdmin, phone);
  }
}
