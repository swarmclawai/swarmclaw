'use client'

import { Check, ArrowRight, Bot, Cable, Server, Sparkles, Clock, Shield } from 'lucide-react'

const services = [
  {
    icon: Bot,
    title: 'Custom AI Agents',
    from: '$2,500',
    timeline: '1-3 weeks',
    description: 'Purpose-built AI agents that automate your specific workflow.',
    includes: [
      'Requirements analysis & agent design',
      'Multi-provider implementation (OpenAI, Anthropic, local LLMs)',
      'Tool integrations (APIs, databases, file systems)',
      'Memory and context management',
      'Deployment & testing',
      'Documentation & handoff',
    ],
    examples: [
      'Research agents that gather and synthesize market intelligence',
      'Customer support agents with full conversation history',
      'Data processing agents for ETL workflows',
      'Content generation agents with brand voice consistency',
    ],
  },
  {
    icon: Cable,
    title: 'Agent Integrations',
    from: '$1,500',
    timeline: '1-2 weeks',
    description: 'Connect AI agents to your existing tools and platforms.',
    includes: [
      'API integration (REST, GraphQL, gRPC)',
      'Database connections (PostgreSQL, MongoDB, etc.)',
      'CRM/ERP integrations (Salesforce, HubSpot, SAP)',
      'Messaging platforms (Slack, Discord, WhatsApp)',
      'Custom webhook setup',
      'Authentication & security hardening',
    ],
    examples: [
      'Slack bot that queries internal knowledge base',
      'WhatsApp customer service agent',
      'Agent that writes to your CRM automatically',
      'GitHub webhook that triggers code review agents',
    ],
  },
  {
    icon: Server,
    title: 'Platform Deployment',
    from: '$1,000',
    timeline: '3-5 days',
    description: 'Full SwarmClaw deployment on your infrastructure.',
    includes: [
      'Server provisioning & setup',
      'Docker/Kubernetes deployment',
      'SSL & domain configuration',
      'Provider credential setup',
      'Team onboarding (2 hours)',
      '30 days of support',
    ],
    examples: [
      'AWS deployment with auto-scaling',
      'Self-hosted on-premise installation',
      'Vercel/Railway one-click deploy setup',
      'Enterprise single-tenant deployment',
    ],
  },
]

const whyUs = [
  {
    icon: Clock,
    title: 'Fast Turnaround',
    description: 'Most projects ship within 2 weeks. MVP deployments in days.',
  },
  {
    icon: Shield,
    title: 'Battle-Tested Stack',
    description: 'Built on SwarmClaw — the open-source agent orchestration platform.',
  },
  {
    icon: Sparkles,
    title: 'Expert Engineers',
    description: 'Team that built the platform. Deep expertise in LLMs, tools, and production systems.',
  },
]

export default function ServicesPage() {
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
            <a href="/services" className="text-accent-bright">Services</a>
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
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent-soft text-accent-bright text-sm font-600 mb-6">
          <Sparkles className="w-4 h-4" />
          AI Agent Development Services
        </div>
        <h1 className="font-display text-5xl font-800 tracking-tight mb-4">
          Custom Agents Built for You
        </h1>
        <p className="text-xl text-text-2 max-w-2xl mx-auto">
          We design, build, and deploy AI agents tailored to your workflow.
          From concept to production in weeks.
        </p>
      </section>

      {/* Services */}
      <section className="max-w-6xl mx-auto px-6 pb-16">
        <div className="grid gap-8">
          {services.map((service) => {
            const Icon = service.icon
            return (
              <div
                key={service.title}
                className="p-8 rounded-2xl bg-surface border border-white/[0.06]"
              >
                <div className="grid md:grid-cols-[1fr,1.5fr,1fr] gap-8">
                  {/* Left: Title & Price */}
                  <div>
                    <div className="flex items-center gap-3 mb-3">
                      <div className="p-2.5 rounded-xl bg-accent-soft">
                        <Icon className="w-5 h-5 text-accent-bright" />
                      </div>
                      <h2 className="font-display text-xl font-700">{service.title}</h2>
                    </div>
                    <p className="text-text-2 text-sm mb-4">{service.description}</p>
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="font-display text-3xl font-800">{service.from}</span>
                    </div>
                    <div className="text-text-3 text-sm">
                      Typical timeline: {service.timeline}
                    </div>
                  </div>

                  {/* Middle: Includes */}
                  <div>
                    <h3 className="text-sm font-600 text-text-3 uppercase tracking-wider mb-3">
                      Includes
                    </h3>
                    <ul className="space-y-2">
                      {service.includes.map((item) => (
                        <li key={item} className="flex items-start gap-2.5 text-sm">
                          <Check className="w-4 h-4 text-success mt-0.5 flex-shrink-0" />
                          <span className="text-text-2">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Right: Examples */}
                  <div>
                    <h3 className="text-sm font-600 text-text-3 uppercase tracking-wider mb-3">
                      Example Projects
                    </h3>
                    <ul className="space-y-2 text-sm text-text-2">
                      {service.examples.map((example) => (
                        <li key={example} className="pl-4 border-l border-white/[0.06]">
                          {example}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="mt-6 pt-6 border-t border-white/[0.06]">
                  <a
                    href="#contact"
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent-bright text-white font-600 hover:bg-accent-bright/90 transition"
                  >
                    Get a Quote
                    <ArrowRight className="w-4 h-4" />
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* Why Us */}
      <section className="bg-surface border-y border-white/[0.06]">
        <div className="max-w-5xl mx-auto px-6 py-16">
          <h2 className="font-display text-2xl font-800 tracking-tight text-center mb-10">
            Why Work With Us
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            {whyUs.map((item) => {
              const Icon = item.icon
              return (
                <div key={item.title} className="text-center">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-accent-soft mb-4">
                    <Icon className="w-6 h-6 text-accent-bright" />
                  </div>
                  <h3 className="font-display text-lg font-700 mb-2">{item.title}</h3>
                  <p className="text-sm text-text-2">{item.description}</p>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* Contact Form */}
      <section id="contact" className="max-w-xl mx-auto px-6 py-20">
        <h2 className="font-display text-2xl font-800 tracking-tight mb-2 text-center">
          Tell Us About Your Project
        </h2>
        <p className="text-text-2 text-center mb-8">
          We'll respond within 24 hours with a detailed proposal.
        </p>

        <form className="space-y-4" onSubmit={(e) => {
          e.preventDefault()
          alert('Thanks! We\'ll be in touch within 24 hours. For immediate response, email hello@swarmclaw.dev')
        }}>
          <div className="grid md:grid-cols-2 gap-4">
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
          </div>
          <div>
            <label className="block text-sm font-600 mb-2">Service</label>
            <select
              className="w-full px-4 py-3 rounded-xl bg-surface border border-white/[0.06] text-text outline-none focus:border-accent-bright/40 transition appearance-none cursor-pointer"
              defaultValue=""
              required
            >
              <option value="" disabled>Select a service...</option>
              <option value="custom-agent">Custom AI Agent Development</option>
              <option value="integration">Agent Integration / Connectors</option>
              <option value="deployment">Platform Deployment</option>
              <option value="consulting">General Consulting</option>
              <option value="other">Other / Not Sure Yet</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-600 mb-2">Budget Range</label>
            <select
              className="w-full px-4 py-3 rounded-xl bg-surface border border-white/[0.06] text-text outline-none focus:border-accent-bright/40 transition appearance-none cursor-pointer"
              defaultValue=""
            >
              <option value="" disabled>Select a range (optional)</option>
              <option value="under-2k">Under $2,000</option>
              <option value="2k-5k">$2,000 - $5,000</option>
              <option value="5k-10k">$5,000 - $10,000</option>
              <option value="10k-25k">$10,000 - $25,000</option>
              <option value="25k-plus">$25,000+</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-600 mb-2">Project Details</label>
            <textarea
              rows={5}
              className="w-full px-4 py-3 rounded-xl bg-surface border border-white/[0.06] text-text placeholder:text-text-3 outline-none focus:border-accent-bright/40 transition resize-none"
              placeholder="Describe what you're trying to automate or build. Include any specific tools, APIs, or platforms you need to integrate with."
              required
            />
          </div>
          <button
            type="submit"
            className="w-full py-3 rounded-xl bg-accent-bright text-white font-600 hover:bg-accent-bright/90 transition"
          >
            Request a Quote
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
