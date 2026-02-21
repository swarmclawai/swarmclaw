import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getSecret } from '@/lib/server/storage'

// Get Stripe instance
async function getStripe(): Promise<Stripe> {
  let secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    const stripeSecret = await getSecret('stripe')
    if (stripeSecret?.value) secretKey = stripeSecret.value
  }
  if (!secretKey) {
    throw new Error('Stripe not configured')
  }
  return new Stripe(secretKey, { apiVersion: '2026-01-28.clover' })
}

// Webhook handler for Stripe events
export async function POST(request: NextRequest) {
  const body = await request.text()
  const signature = request.headers.get('stripe-signature')

  if (!signature) {
    return NextResponse.json({ error: 'No signature' }, { status: 400 })
  }

  let webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!webhookSecret) {
    const webhookSecretRecord = await getSecret('stripe_webhook')
    if (webhookSecretRecord?.value) webhookSecret = webhookSecretRecord.value
  }

  let stripe: Stripe
  try {
    stripe = await getStripe()
  } catch {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })
  }

  // Verify webhook signature
  let event: Stripe.Event
  try {
    if (!webhookSecret) {
      // In dev, skip verification
      event = JSON.parse(body)
    } else {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
    }
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        console.log('✅ Payment successful:', session.id)
        
        // TODO: Provision the subscription
        // - Store customer ID
        // - Update user's subscription tier
        // - Grant access to features
        
        const customerEmail = session.customer_details?.email
        const customerId = session.customer as string
        const subscriptionId = session.subscription as string
        
        console.log(`Customer: ${customerEmail}, Subscription: ${subscriptionId}`)
        break
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        console.log('📝 Subscription updated:', subscription.id)
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        console.log('❌ Subscription canceled:', subscription.id)
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        console.log('⚠️ Payment failed:', invoice.id)
        break
      }

      default:
        console.log(`Unhandled event type: ${event.type}`)
    }

    return NextResponse.json({ received: true })
  } catch (error: any) {
    console.error('Error processing webhook:', error)
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
}
