import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export const createStripeCheckout = createServerFn({ method: "POST" })
  .inputValidator((data: { orderId: string; origin: string }) => data)
  .handler(async ({ data }) => {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      return { error: "Stripe não configurado. Peça ao administrador para adicionar STRIPE_SECRET_KEY." };
    }

    const supabase = createClient<Database>(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY!,
      { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
    );

    const { data: order, error } = await supabase
      .from("orders")
      .select("id, order_number, total, customer_name, customer_phone, payment_method, status")
      .eq("id", data.orderId)
      .maybeSingle();

    if (error || !order) return { error: "Pedido não encontrado" };
    if (order.payment_method !== "card") return { error: "Este pedido não é pagamento em cartão" };

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(key);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "brl",
          unit_amount: Math.round(Number(order.total) * 100),
          product_data: { name: `Pedido #${order.order_number} — HotBox Delivery` },
        },
      }],
      success_url: `${data.origin}/pedido/${order.id}?paid=1`,
      cancel_url: `${data.origin}/pedido/${order.id}?canceled=1`,
      metadata: { order_id: order.id, order_number: String(order.order_number) },
      customer_email: undefined,
    });

    await supabase.from("orders").update({ payment_link: session.url }).eq("id", order.id);

    return { url: session.url };
  });
