import { createFileRoute } from "@tanstack/react-router";
import { sendSatisfactionForOrder } from "@/lib/satisfaction.functions";

// Chamado pelo pg_cron a cada minuto. Envia automaticamente o convite de
// avaliação para pedidos entregues há pelo menos 10 minutos e ainda sem envio.
export const Route = createFileRoute("/api/public/hooks/satisfaction-auto")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const cutoff = Date.now() - 10 * 60 * 1000;

        const { data: cfg } = await supabaseAdmin
          .from("store_config")
          .select("app_public_url")
          .maybeSingle();
        let origin = String(cfg?.app_public_url ?? "").replace(/\/$/, "");
        if (!origin) {
          try { origin = new URL(request.url).origin; } catch { origin = ""; }
        }
        if (!origin) return Response.json({ ok: false, error: "app_public_url não configurada" }, { status: 500 });

        // Busca entregues recentes e filtra em memória para aceitar sistemas antigos
        // nos quais delivered_at eventualmente ficou nulo.
        const { data: orders, error } = await supabaseAdmin
          .from("orders")
          .select("id,delivered_at,updated_at,created_at")
          .eq("status", "delivered")
          .order("updated_at", { ascending: true })
          .limit(100);
        if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

        const candidateIds = (orders ?? [])
          .filter((o: any) => {
            const at = new Date(o.delivered_at || o.updated_at || o.created_at).getTime();
            return Number.isFinite(at) && at <= cutoff;
          })
          .map((o: any) => o.id);

        if (!candidateIds.length) return Response.json({ ok: true, processed: 0, sent: 0 });

        const { data: feedbackRows } = await supabaseAdmin
          .from("customer_feedback")
          .select("order_id,sent_at,submitted_at")
          .in("order_id", candidateIds);
        const done = new Set((feedbackRows ?? [])
          .filter((f: any) => f.order_id && (f.sent_at || f.submitted_at))
          .map((f: any) => f.order_id));

        let sent = 0;
        let failed = 0;
        for (const orderId of candidateIds) {
          if (done.has(orderId)) continue;
          try {
            const result = await sendSatisfactionForOrder({ supabaseAdmin, orderId, origin });
            if (result.ok && !result.alreadySent) sent++;
            else if (!result.ok) failed++;
          } catch (err) {
            failed++;
            console.error("[satisfaction-auto] erro", { orderId, err });
          }
        }

        return Response.json({ ok: true, processed: candidateIds.length, sent, failed });
      },
    },
  },
});
