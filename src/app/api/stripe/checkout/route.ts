import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getSecret } from '@/lib/server/storage'

// Initialize Stripe with secret key from environment or secrets store
async function getStripe(): Promise<Stripe> {
  let secretKey = process.env.STRIPE_SECRET_KEY

  if (!secretKey) {
    const stripeSecret = await getSecret('stripe')
    if (stripeSecret?.value) secretKey = stripeSecret.value
  }

  if (!secretKey) {
    throw new Error('Stripe not configured. Add STRIPE_SECRET_KEY to environment or secrets.')
  }

  return new Stripe(secretKey, { apiVersion: '2026-01-28.clover' })
}

// Map price IDs to actual Stripe Price IDs (configured in Stripe Dashboard)
const PRICE_MAP: Record<string, string> = {
  'price_starter_monthly': process.env.STRIPE_PRICE_STARTER || 'price_starter_monthly',
  'price_pro_monthly': process.env.STRIPE_PRICE_PRO || 'price_pro_monthly',
  'price_enterprise_monthly': process.env.STRIPE_PRICE_ENTERPRISE || 'price_enterprise_monthly',
}

export async function POST(request: NextRequest) {
  try {
    const stripe = await getStripe()
    const body = await request.json()
    const { priceId } = body

    if (!priceId || !PRICE_MAP[priceId]) {
      return NextResponse.json(
        { error: 'Invalid price ID' },
        { status: 400 }
      )
    }

    const actualPriceId = PRICE_MAP[priceId]

    // Get origin for redirect URLs
    const origin = request.headers.get('origin') || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3456'

    // Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: actualPriceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${origin}/pricing?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing?canceled=true`,
      metadata: {
        source: 'swarmclaw-pricing',
      },
    })

    return NextResponse.json({ url: session.url })
  } catch (error: unknown) {
    console.error('Stripe checkout error:', error)
    const message = error instanceof Error ? error.message : 'Failed to create checkout session'
    return NextResponse.json(
      { error: message },
      { status: 500 }
    )
  }
}
