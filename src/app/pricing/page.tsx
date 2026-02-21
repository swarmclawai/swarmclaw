'use client'

import { useState } from 'react'
import { Check, Zap, Building2, Rocket, ArrowRight } from 'lucide-react'

const plans = [
  {
    name: 'Starter',
    price: 0,
    period: 'forever',
    description: 'Self-host SwarmClaw on your own infrastructure',
    features: [
      'All core features',
      'Unlimited agents & sessions',
      'Multi-provider support',
      'CLI & Web UI',
      'Connectors framework',
      'MIT License (free forever)',
    ],
    cta: 'Get Started',
    ctaLink: 'https://github.com/swarmclaw/swarmclaw',
    highlighted: false,
    icon: Rocket,
  },
  {
    name: 'Pro',
    price: 49,
    period: '/month',
    description: 'Managed hosting — we run it for you',
    features: [
      'Everything in Starter',
      'Fully managed hosting',
      'Automatic updates & backups',
      '99.9% uptime SLA',
      'Email support',
      'Custom domain included',
      '10,000 messages/month',
    ],
    cta: 'Start Free Trial',
    ctaLink: '#contact',
    highlighted: true,
    icon: Zap,
    popular: true,
  },
  {
    name: 'Enterprise',
    price: 199,
    period: '/month',
    description: 'Dedicated infrastructure with premium support',
    features: [
      'Everything in Pro',
      'Dedicated server',
      'Unlimited messages',
      'Priority support (4hr response)',
      'Custom integrations',
      'SSO & SAML',
      'SLA customization',
      'On-premise option',
    ],
    cta: 'Contact Sales',
    ctaLink: '#contact',
    highlighted: false,
    icon: Building2,
  },
]

const services = [
  {
    title: 'Custom Agent Development',
    from: '$2,500',
    description: 'Build specialized AI agents tailored to your workflow. Automation, data processing, customer service, research.',
  },
  {
    title: 'Integration Services',
    from: '$1,500',
    description: 'Connect agents to your existing tools. APIs, databases, CRMs, Slack, WhatsApp, custom webhooks.',
  },
  {
    title: 'Platform Deployment',
    from: '$1,000',
    description: 'Full SwarmClaw deployment on your infrastructure. Setup, configuration, team training included.',
  },
]

export default function PricingPage() {
  const [annual, setAnnual] = useState(true)

  return (
    <div className="min-h-screen bg-bg text-text">
      {/* Header */}
      <header className="border-b border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <a href="/" className="font-display text-xl font-bold tracking-tight">
            SwarmClaw
          </a>
          <nav className="flex items-center gap-6 text-sm">
            <a href="/" className="text-text-2 hover:text-text transition">Dashboard</a>
            <a href="/pricing" className="text-accent-bright">Pricing</a>
            <a href="#services" className="text-text-2 hover:text-text transition">Services</a>
            <a
              href="https://github.com/swarmclaw/swarmclaw"
              target="_blank"
              rel="noopener"
              className="px-4 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-text-2 hover:text-text hover:bg-white/[0.08] transition"
            >
              GitHub
            </a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-20 pb-12 text-center">
        <h1 className="font-display text-5xl font-800 tracking-tight mb-4">
          Ship AI agents faster
        </h1>
        <p className="text-xl text-text-2 max-w-2xl mx-auto">
          Open-source orchestration with optional managed hosting.
          Build once, deploy anywhere.
        </p>
      </section>

      {/* Pricing Toggle */}
      <section className="max-w-6xl mx-auto px-6">
        <div className="flex justify-center mb-10">
          <div className="flex p-1 rounded-xl bg-surface border border-white/[0.06]">
            <button
              onClick={() => setAnnual(true)}
              className={`px-5 py-2 rounded-lg text-sm font-600 transition ${
                annual
                  ? 'bg-accent-bright text-white'
                  : 'text-text-2 hover:text-text'
              }`}
            >
              Annual <span className="text-xs opacity-70 ml-1">Save 20%</span>
            </button>
            <button
              onClick={() => setAnnual(false)}
              className={`px-5 py-2 rounded-lg text-sm font-600 transition ${
                !annual
                  ? 'bg-white/[0.08] text-text'
                  : 'text-text-2 hover:text-text'
              }`}
            >
              Monthly
            </button>
          </div>
        </div>

        {/* Pricing Cards */}
        <div className="grid md:grid-cols-3 gap-6 mb-20">
          {plans.map((plan) => {
            const Icon = plan.icon
            const price = annual && plan.price > 0 ? Math.round(plan.price * 0.8) : plan.price
            return (
              <div
                key={plan.name}
                className={`relative p-6 rounded-2xl border transition-all ${
                  plan.highlighted
                    ? 'bg-gradient-to-b from-accent-soft to-transparent border-accent-bright/30 scale-[1.02] shadow-lg shadow-accent-bright/10'
                    : 'bg-surface border-white/[0.06] hover:border-white/[0.12]'
                }`}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-accent-bright text-white text-xs font-600">
                    Most Popular
                  </div>
                )}
                <div className="flex items-center gap-3 mb-4">
                  <div className={`p-2 rounded-lg ${
                    plan.highlighted ? 'bg-accent-bright/20 text-accent-bright' : 'bg-white/[0.04] text-text-2'
                  }`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <h3 className="font-display text-lg font-700">{plan.name}</h3>
                </div>

                <div className="mb-4">
                  <span className="font-display text-4xl font-800">
                    {plan.price === 0 ? 'Free' : `$${price}`}
                  </span>
                  {plan.price > 0 && (
                    <span className="text-text-3 text-sm">{plan.period}</span>
                  )}
                </div>

                <p className="text-sm text-text-2 mb-6">{plan.description}</p>

                <ul className="space-y-3 mb-6">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5 text-sm">
                      <Check className="w-4 h-4 text-success mt-0.5 flex-shrink-0" />
                      <span className="text-text-2">{feature}</span>
                    </li>
                  ))}
                </ul>

                <a
                  href={plan.ctaLink}
                  className={`block w-full py-3 rounded-xl text-center font-600 transition ${
                    plan.highlighted
                      ? 'bg-accent-bright text-white hover:bg-accent-bright/90'
                      : 'bg-white/[0.04] border border-white/[0.08] text-text hover:bg-white/[0.08]'
                  }`}
                >
                  {plan.cta}
                </a>
              </div>
            )
          })}
        </div>
      </section>

      {/* Services Section */}
      <section id="services" className="bg-surface border-y border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="text-center mb-12">
            <h2 className="font-display text-3xl font-800 tracking-tight mb-3">
              Custom AI Agent Development
            </h2>
            <p className="text-text-2 max-w-xl mx-auto">
              Don't want to build it yourself? Our team will design, build, and deploy
              custom agents for your specific use case.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6 mb-12">
            {services.map((service) => (
              <div
                key={service.title}
                className="p-6 rounded-xl bg-raised border border-white/[0.06] hover:border-white/[0.12] transition"
              >
                <div className="text-accent-bright text-sm font-600 mb-2">
                  From {service.from}
                </div>
                <h3 className="font-display text-lg font-700 mb-2">{service.title}</h3>
                <p className="text-sm text-text-2">{service.description}</p>
              </div>
            ))}
          </div>

          <div className="text-center">
            <a
              href="#contact"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-text hover:bg-white/[0.08] font-600 transition"
            >
              Discuss Your Project
              <ArrowRight className="w-4 h-4" />
            </a>
          </div>
        </div>
      </section>

      {/* Contact Form */}
      <section id="contact" className="max-w-xl mx-auto px-6 py-20">
        <h2 className="font-display text-2xl font-800 tracking-tight mb-2 text-center">
          Get Started
        </h2>
        <p className="text-text-2 text-center mb-8">
          Tell us about your project and we'll get back to you within 24 hours.
        </p>

        <form className="space-y-4" onSubmit={(e) => {
          e.preventDefault()
          // TODO: Wire up to API endpoint
          alert('Thanks! We\'ll be in touch soon. For immediate response, email hello@swarmclaw.dev')
        }}>
          <div>
            <label className="block text-sm font-600 mb-2">Name</label>
            <input
              type="text"
              className="w-full px-4 py-3 rounded-xl bg-surface border border-white/[0.06] text-text placeholder:text-text-3 outline-none focus:border-accent-bright/40 transition"
              placeholder="Your name"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-600 mb-2">Email</label>
            <input
              type="email"
              className="w-full px-4 py-3 rounded-xl bg-surface border border-white/[0.06] text-text placeholder:text-text-3 outline-none focus:border-accent-bright/40 transition"
              placeholder="you@company.com"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-600 mb-2">What are you looking for?</label>
            <select
              className="w-full px-4 py-3 rounded-xl bg-surface border border-white/[0.06] text-text outline-none focus:border-accent-bright/40 transition appearance-none cursor-pointer"
              defaultValue=""
              required
            >
              <option value="" disabled>Select an option...</option>
              <option value="pro">Pro Plan — Managed Hosting ($49/mo)</option>
              <option value="enterprise">Enterprise Plan — Dedicated ($199/mo)</option>
              <option value="custom">Custom Agent Development</option>
              <option value="integration">Integration Services</option>
              <option value="deployment">Platform Deployment</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-600 mb-2">Project details</label>
            <textarea
              rows={4}
              className="w-full px-4 py-3 rounded-xl bg-surface border border-white/[0.06] text-text placeholder:text-text-3 outline-none focus:border-accent-bright/40 transition resize-none"
              placeholder="Tell us about your project, timeline, and any specific requirements..."
            />
          </div>
          <button
            type="submit"
            className="w-full py-3 rounded-xl bg-accent-bright text-white font-600 hover:bg-accent-bright/90 transition"
          >
            Send Message
          </button>
        </form>

        <p className="text-center text-text-3 text-sm mt-6">
          Or email us directly at{' '}
          <a href="mailto:hello@swarmclaw.dev" className="text-accent-bright hover:underline">
            hello@swarmclaw.dev
          </a>
        </p>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between text-sm text-text-3">
          <div>© 2025 SwarmClaw. Open-source under MIT.</div>
          <div className="flex items-center gap-6">
            <a href="https://github.com/swarmclaw/swarmclaw" target="_blank" rel="noopener" className="hover:text-text transition">
              GitHub
            </a>
            <a href="https://discord.gg/swarmclaw" target="_blank" rel="noopener" className="hover:text-text transition">
              Discord
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
