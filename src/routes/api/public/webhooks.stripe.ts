import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/webhooks/stripe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { logApi } = await import("@/lib/api-log.server");
        const { loadStripeConfig } = await import("@/lib/stripe.functions");
        const { activatePaidSiteOrder } = await import("@/lib/site-payment.server");
        const cfg = await loadStripeConfig(supabaseAdmin);

        if (!cfg.enabled || !cfg.secretKey || !cfg.webhookSecret) {
          await logApi(supabaseAdmin, {
            source: "stripe_webhook",
            direction: "in",
            response_status: 500,
            error_message: "Stripe desativado ou credenciais incompletas em store_config",
          });
          return new Response("stripe not configured", { status: 500 });
        }

        const sig = request.headers.get("stripe-signature");
        if (!sig) return new Response("missing signature", { status: 400 });
        const body = await request.text();
        const Stripe = (await import("stripe")).default;
        const stripe = new Stripe(cfg.secretKey);

        let event: any;
        try {
          event = await stripe.webhooks.constructEventAsync(body, sig, cfg.webhookSecret);
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
          if (orderId && (session.payment_status === "paid" || event.type === "checkout.session.async_payment_succeeded")) {
            const result = await activatePaidSiteOrder(supabaseAdmin, orderId, "stripe", session.payment_intent || session.id);
            await logApi(supabaseAdmin, {
              source: "stripe_webhook",
              direction: "in",
              request_payload: { event_type: event.type, order_id: orderId, payment_status: session.payment_status },
              response_status: result.ok ? 200 : 500,
              error_message: result.ok ? undefined : result.error,
            });
            if (!result.ok) return new Response(result.error || "activation failed", { status: 500 });
          }
        }

        return new Response("ok");
      },
    },
  },
});
