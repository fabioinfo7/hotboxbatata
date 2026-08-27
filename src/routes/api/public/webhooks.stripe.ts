import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/webhooks/stripe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { logApi } = await import("@/lib/api-log.server");

        const key = process.env.STRIPE_SECRET_KEY;
        const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!key || !whSecret) {
          await logApi(supabaseAdmin, {
            source: "stripe_webhook",
            direction: "in",
            response_status: 500,
            error_message: "STRIPE_SECRET_KEY ou STRIPE_WEBHOOK_SECRET não configurados",
          });
          return new Response("stripe not configured", { status: 500 });
        }

        const sig = request.headers.get("stripe-signature");
        if (!sig) {
          await logApi(supabaseAdmin, {
            source: "stripe_webhook",
            direction: "in",
            response_status: 400,
            error_message: "faltou o cabeçalho stripe-signature",
          });
          return new Response("missing signature", { status: 400 });
        }
        const body = await request.text();

        const Stripe = (await import("stripe")).default;
        const stripe = new Stripe(key);
        let event: any;
        try {
          event = await stripe.webhooks.constructEventAsync(body, sig, whSecret);
        } catch (e: any) {
          await logApi(supabaseAdmin, {
            source: "stripe_webhook",
            direction: "in",
            response_status: 400,
            error_message: `assinatura inválida: ${e.message}`,
          });
          return new Response(`bad signature: ${e.message}`, { status: 400 });
        }

        if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
          const session = event.data.object as any;
          const orderId = session?.metadata?.order_id as string | undefined;
          if (orderId) {
            const { error } = await supabaseAdmin.from("orders").update({ payment_status: "paid" }).eq("id", orderId);
            await logApi(supabaseAdmin, {
              source: "stripe_webhook",
              direction: "in",
              request_payload: { event_type: event.type, order_id: orderId },
              response_status: error ? 500 : 200,
              error_message: error?.message,
            });
          }
        }

        return new Response("ok");
      },
    },
  },
});
