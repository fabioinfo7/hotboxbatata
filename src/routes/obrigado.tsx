import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, MessageCircle, Receipt, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/obrigado")({ component: ObrigadoPage });

const WHATSAPP_URL = "https://wa.me/5521984296288?text=" + encodeURIComponent("Olá! Acabei de fazer um pedido pelo cardápio digital da Hotbox.");

function ObrigadoPage() {
  const [state, setState] = useState<"checking" | "paid" | "pending">("checking");
  const [orderId, setOrderId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams(window.location.search);
    const order_nsu = params.get("order_nsu") || "";
    const transaction_nsu = params.get("transaction_nsu") || "";
    const slug = params.get("slug") || "";
    setReceipt(params.get("receipt_url"));

    async function confirm() {
      if (!order_nsu || !transaction_nsu || !slug) {
        if (alive) setState("pending");
        return;
      }
      try {
        const { confirmInfinitePayReturn } = await import("@/lib/infinitepay.functions");
        const result = await confirmInfinitePayReturn({ data: { order_nsu, transaction_nsu, slug } });
        if (!alive) return;
        if (result.ok) {
          setOrderId(result.order_id || null);
          setState("paid");
        } else {
          setState("pending");
        }
      } catch {
        if (alive) setState("pending");
      }
    }
    void confirm();
    return () => { alive = false; };
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-b from-[#1b0905] via-[#6c160e] to-[#f7f4ef] px-4 py-10">
      <div className="mx-auto max-w-lg overflow-hidden rounded-[34px] bg-white shadow-2xl">
        <div className="bg-gradient-to-br from-[#ffd400] to-[#ff9f1a] p-7 text-center text-black">
          {state === "checking" ? <Loader2 className="mx-auto size-14 animate-spin" /> : <CheckCircle2 className="mx-auto size-16" />}
          <h1 className="mt-4 font-display text-3xl font-black">{state === "paid" ? "Pagamento confirmado!" : state === "checking" ? "Confirmando seu pagamento" : "Pagamento recebido"}</h1>
          <p className="mt-2 text-sm font-semibold">Obrigado por escolher a Hotbox. 🔥</p>
        </div>
        <div className="space-y-4 p-6 sm:p-8">
          <div className="rounded-2xl border bg-emerald-50 p-4 text-sm leading-relaxed text-emerald-950">
            {state === "paid" ? "Seu pedido já entrou no nosso sistema e seguirá para preparo." : "Estamos finalizando a confirmação. Você não precisa pagar novamente."}
          </div>
          <div className="rounded-2xl border p-4">
            <div className="flex items-start gap-3"><MessageCircle className="mt-0.5 size-5 text-[#25D366]" /><div><p className="font-black">Acompanhe pelo WhatsApp</p><p className="mt-1 text-sm text-muted-foreground">Vamos enviar as atualizações do seu pedido por WhatsApp, inclusive quando sair para entrega.</p></div></div>
          </div>
          {orderId && <p className="text-center text-xs text-muted-foreground">Pedido confirmado no sistema.</p>}
          <a href={WHATSAPP_URL} target="_blank" rel="noreferrer"><Button className="w-full rounded-full bg-[#25D366] py-6 font-black text-white hover:bg-[#20bd5a]"><MessageCircle className="size-5" /> Abrir WhatsApp</Button></a>
          {receipt && <a href={receipt} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-2 text-sm font-bold text-primary"><Receipt className="size-4" /> Ver comprovante do pagamento</a>}
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground"><Clock className="size-4" /> Você pode fechar esta página com segurança.</div>
        </div>
      </div>
    </main>
  );
}
