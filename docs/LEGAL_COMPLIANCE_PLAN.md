# NanoClaw Legal And Compliance Plan

> Working document for implementation planning.
> Not legal advice. Must be reviewed by qualified counsel in each target jurisdiction before launch.

## Purpose

This document is a practical compliance plan for running NanoClaw as a commercial AI-assisted service in Europe, with focus on:

- GDPR and privacy governance
- AI Act readiness
- security and breach response procedures
- customer contracts and processor obligations
- cross-border data transfer controls
- website and product accessibility
- optional US expansion controls such as CCPA
- audit evidence needed to defend decisions, reduce regulatory exposure, and answer enterprise due diligence

The goal is not to collect random badges. The goal is to build a defensible operating model.

## Executive Summary

For a European AI SaaS handling customer conversations, bookings, scheduling, and potentially tenant-specific business data, the minimum serious compliance baseline is:

- GDPR governance implemented and documented
- clear controller/processor role mapping
- Article 28 compliant DPAs with customers and subprocessors
- records of processing activities
- retention schedule and deletion workflow
- DSAR workflow
- breach response workflow with 72-hour escalation path
- transfer assessment for any non-EEA processing
- AI transparency and human escalation procedures
- vendor due diligence for model, cloud, messaging, analytics, and support tooling
- security controls that match the risk profile

Everything else is either:

- conditionally required depending on business model or market
- useful for enterprise sales
- marketing only

## Important Disclaimer

Compliance is not achieved by a privacy policy alone.

You need:

- correct contracts
- correct product behavior
- correct internal procedures
- correct evidence

If regulators or enterprise customers ask questions, the safest position is not "we intended to comply" but "here is the policy, the system behavior, the owner, the evidence, and the date implemented."

## Product-Specific Assumptions

This plan assumes NanoClaw may:

- receive end-user messages through channels such as WhatsApp
- process customer and tenant data inside chat history, memory files, logs, and scheduled task results
- send user data to third-party model providers and infrastructure providers
- store conversation data per group and task history
- let an agent read files mounted for a tenant
- run automated or semi-automated responses about bookings or tenant operations

This creates legal exposure in at least five domains:

- privacy and data protection
- information security
- AI transparency and oversight
- platform and third-party terms risk
- consumer and contract risk

## What Is Likely Applicable First

### 1. GDPR

Almost certainly applicable if personal data of EU/EEA persons is processed.

Key operational consequences:

- identify controller vs processor role per data flow
- define lawful basis for each processing purpose
- sign DPAs where required
- publish privacy notices
- support data subject rights
- implement retention and deletion
- document security measures
- assess international transfers
- notify personal data breaches when required

### 2. EU AI Act

Likely relevant even if NanoClaw is not a prohibited or high-risk AI system.

Why it matters:

- transparency rules may apply when people interact with AI
- model/provider governance matters
- higher risk use cases may trigger stronger controls
- enterprise buyers will ask for AI governance even before enforcement pressure hits

For NanoClaw, the likely baseline is not full high-risk compliance, but:

- AI use disclosure
- human oversight and escalation
- logging and traceability
- risk classification
- prohibited-use policy
- change management for prompts, tools, and models

### 3. ePrivacy / Cookie Rules

Relevant if you run a website, dashboard, tracking, analytics, or non-essential cookies.

If you later build a public web app or admin portal, cookie compliance becomes a separate workstream from GDPR.

### 4. Accessibility

Relevant if you offer websites, web apps, mobile apps, or digital services to the public.

In Europe, accessibility is not just a design quality issue. It can become a legal requirement depending on the service and entity scope. A WCAG 2.2 AA target is a reasonable implementation baseline.

### 5. Consumer Law / Distance Selling / Transparency

Relevant if customers buy the product online, especially SMB and consumer-facing offerings.

You need:

- clear terms
- pricing transparency
- service description
- support and complaint channels
- fair limitations of liability
- cancellation/refund logic where required

### 6. Information Security Expectations

Even where not independently mandated by law, they become mandatory in practice through:

- GDPR Article 32
- customer contracts
- vendor due diligence questionnaires
- enterprise procurement
- cyber insurance requirements

### 7. Conditional Regimes

May or may not apply depending on growth, geography, or product design:

- NIS2
- CCPA/CPRA
- PCI DSS
- DPF/SCC transfer mechanisms
- local telecom and electronic communications rules
- employment monitoring rules

## Badge Review: What Matters And What Does Not

The badges in the screenshot are not equal.

### Must treat as potentially material

- GDPR: real and relevant
- WCAG 2.2: relevant if you have a website/app subject to accessibility obligations
- PCI DSS SAQ A: only if you accept card payments in a way that puts you in PCI scope
- CCPA: relevant only if you target California and hit the statutory thresholds
- Data Privacy Framework: relevant only for certain EU-US data transfer scenarios
- SOC 2: not a law, but highly valuable for enterprise sales and trust

### Do not confuse with legal compliance

- BBB Accredited Business: reputation/marketing signal, not a legal compliance framework

### Missing from the badges, but important

- EU AI Act
- SCCs and transfer impact assessments
- incident response and breach notification readiness
- controller/processor contract framework
- subprocessor governance
- data retention and deletion controls
- platform terms compliance for messaging channels and other integrations

## Immediate Product And Business Risks To Assess

These should be reviewed before selling the product at scale.

### A. Controller vs Processor Ambiguity

You need a written position for each flow:

- tenant/end-customer conversation content
- booking data
- support tickets
- billing data
- analytics/telemetry
- model provider requests

Likely outcome:

- for tenant conversation data, you may act primarily as processor
- for your own billing, account security, fraud prevention, and product analytics, you may act as controller

If you do not document this cleanly, your DPA and privacy notice will be internally inconsistent.

### B. Messaging Channel Terms Risk

NanoClaw currently depends on messaging channels and libraries such as WhatsApp Web tooling. Independent of privacy law, you need a written terms-risk assessment for each channel:

- is the integration officially supported
- does the channel permit your commercial use case
- can accounts be restricted or banned
- what contractual promises can you make to customers if the channel provider changes policy

This is a major legal and business continuity issue, not just a technical one.

### C. Retention Risk

Current architecture stores conversations, sessions, files, task logs, and memory. That is operationally useful but legally dangerous unless you define:

- what is stored
- why it is stored
- for how long
- who can access it
- how it is deleted from primary and backup systems

### D. Sensitive Data Risk

Booking and concierge-style flows can unexpectedly contain:

- health data
- disability/accessibility requests
- religious or dietary preferences
- travel and location data
- child data

That can move a flow into a higher-risk privacy posture.

## Required Legal Workstreams

## 1. Governance And Accountability

Deliverables:

- legal entity and establishment map
- compliance owner
- security owner
- privacy owner
- decision on whether a DPO is legally required or voluntarily appointed
- decision on whether an EU representative is required if the operating company is outside the EU
- governance calendar for annual review

Actions:

- assign executive owner for privacy and security
- define approval path for new vendors, new integrations, and new AI use cases
- create a compliance evidence folder with versioned records
- maintain an issues/risk register with owners and target dates

## 2. Data Inventory And Role Mapping

Deliverables:

- data map
- RoPA (record of processing activities)
- system inventory
- data flow diagram
- controller/processor matrix

For each dataset, document:

- data category
- data subjects
- source
- purpose
- lawful basis
- recipients
- storage location
- retention period
- transfer location
- security controls

Minimum datasets to map:

- inbound messages
- outbound responses
- tenant account data
- booking data
- logs and audit trails
- scheduled task history
- uploaded files and mounted data
- support communications
- billing and invoicing
- website analytics and marketing data

## 3. Customer-Facing Legal Documents

Minimum external documents:

- Terms of Service or Master Services Agreement
- Privacy Notice
- Data Processing Agreement for customers
- Subprocessor List
- Security Overview
- AI Use Notice
- Acceptable Use Policy
- Cookie Notice if applicable

Terms should address at minimum:

- scope of service
- AI-generated outputs and customer responsibility
- acceptable use and prohibited use
- channel dependencies and third-party service dependencies
- service availability disclaimers
- intellectual property positions
- liability cap
- data processing roles
- incident notification commitments
- suspension and termination rights

## 4. Vendor And Subprocessor Governance

Every vendor must have a file containing:

- service description
- role in the processing chain
- data categories sent
- region of processing
- DPA status
- SCC/DPF status where relevant
- security review date
- offboarding plan

Priority vendor reviews:

- model provider
- cloud provider
- database/backup provider
- messaging/channel provider
- error tracking and analytics provider
- customer support tooling
- email provider

For each non-EEA transfer, document:

- whether adequacy exists
- whether DPF certification is relied upon
- whether SCCs are in place
- whether a transfer impact assessment is needed

## 5. Privacy Law Mechanics Under GDPR

### Lawful basis

Create a lawful-basis table by purpose. Example categories:

- contract performance for service delivery
- legal obligation for invoicing and accounting
- legitimate interests for service security, abuse prevention, limited analytics, and troubleshooting
- consent only where actually needed, such as certain marketing or non-essential cookies

Do not use consent as a lazy default.

### Article 28 compliance

If acting as processor for tenants, your DPA must cover at least:

- subject matter and duration
- nature and purpose
- type of personal data
- categories of data subjects
- documented instructions
- confidentiality
- security measures
- subprocessor approval mechanism
- assistance with rights requests
- assistance with DPIAs and breach handling
- deletion or return on termination
- audit support

### Data subject rights operations

Create a written procedure for:

- access
- rectification
- deletion
- restriction
- objection
- portability
- complaint handling

Operational requirements:

- intake channel
- identity verification standard
- response deadlines
- escalation path
- exceptions register
- evidence of completion

### Retention and deletion

Create a retention schedule with default periods for:

- customer account data
- conversation history
- logs
- task history
- backups
- billing records
- security investigation records

Deletion must cover:

- live database
- filesystem data
- logs where feasible
- backups at end of backup lifecycle
- subprocessor deletion requests where required

### DPIA triggers

Perform a DPIA if processing is likely to result in high risk. Trigger examples:

- systematic monitoring
- large-scale profiling
- sensitive data in bookings or support
- automated decisions with significant effects
- large-scale processing of chat histories

## 6. Security And Incident Management

This is both a GDPR and enterprise trust issue.

Minimum policies and procedures:

- access control policy
- secrets management standard
- secure development procedure
- change management procedure
- logging and monitoring standard
- vulnerability management process
- backup and restore procedure
- incident response plan
- breach notification playbook
- business continuity and disaster recovery plan

Minimum technical controls:

- least privilege access
- MFA for admin systems
- encryption in transit
- encryption at rest where feasible
- secrets outside code and containers
- environment separation
- role-based access control
- audit logging for admin actions
- restore testing
- periodic access review

Project-specific recommendations for NanoClaw:

- add network egress policy for containers where feasible
- define retention on session transcripts and task logs
- document mount approval workflow
- document who may access tenant-mounted files
- document how credentials are rotated and how proxy access is monitored

### Breach response

You need a tested runbook for:

- incident detection
- severity classification
- forensics preservation
- internal escalation
- customer notification
- supervisory authority notification
- post-incident corrective actions

The breach plan must explicitly support GDPR Article 33 and Article 34 timing decisions.

## 7. AI Governance Workstream

Do not treat this as generic privacy.

Deliverables:

- AI use-case register
- model/provider approval checklist
- prohibited-use policy
- human oversight policy
- model change log
- evaluation and red-team procedure
- incident classification for harmful outputs

Operational controls:

- disclose when users interact with AI where appropriate
- provide a human escalation path for disputes or critical booking issues
- prohibit high-risk or legally sensitive autonomous use without review
- log prompts, tools used, and major actions subject to privacy limits
- test for hallucinations, prompt injection, data leakage, and unauthorized actions
- document whether provider uses customer data for training and how this is contractually controlled
- document model switching procedure and re-validation

AI Act review checklist:

- is NanoClaw merely a deployer of third-party general-purpose models or also a provider of an AI system under your own brand
- does any use case fall into prohibited AI practices
- does any workflow become high-risk
- do you need transparency notices for end users
- do you have human oversight and complaint handling

## 8. Website, Cookies, Marketing, And Accessibility

If you operate a public website or SaaS console:

- implement a privacy notice at collection
- implement cookie inventory and consent where needed
- avoid loading non-essential trackers before consent
- publish accessible support contact paths
- target WCAG 2.2 AA for public web experiences

Accessibility implementation checklist:

- keyboard navigation
- semantic HTML
- color contrast
- focus visibility
- form labels and error messaging
- alt text
- accessible authentication flows
- responsive layouts
- screen-reader testing

## 9. Cross-Border Transfers

For every transfer outside the EEA, maintain a transfer memo stating:

- destination country
- vendor
- transfer purpose
- transfer mechanism used
- supplementary measures
- review date

Transfer mechanisms may include:

- adequacy decision
- Data Privacy Framework where available and appropriate
- SCCs
- additional technical or organizational safeguards

## 10. Payments, If Introduced

Do not advertise PCI DSS SAQ A unless you actually scope and validate it.

PCI becomes relevant if you accept payment cards.

Best practice:

- use a hosted payment page or embedded provider that keeps card data away from your systems
- avoid storing, processing, or transmitting cardholder data directly
- confirm SAQ type with your acquiring bank or payment provider

## 11. US Expansion, If Introduced

CCPA/CPRA is not your first problem unless you operate in California and hit the thresholds.

Still, prepare for expansion by designing:

- notice at collection mechanics
- deletion and correction workflows
- opt-out logic where applicable
- subprocessor disclosure

## 12. Audit Evidence Package

Keep an evidence pack. Without evidence, policies are weak.

Recommended contents:

- signed DPA templates
- executed customer DPAs
- executed vendor DPAs/SCCs
- current subprocessor list
- RoPA
- retention schedule
- incident response plan
- access review records
- backup test records
- vulnerability remediation log
- AI risk assessments
- DPIAs and TIAs
- privacy notice versions
- training completion records

## Implementation Roadmap

## Phase 1: First 30 Days

Must complete:

- appoint internal owners
- create data map
- create controller/processor matrix
- create vendor register
- draft Privacy Notice
- draft customer DPA
- draft subprocessor list
- draft retention schedule
- draft incident response plan
- review messaging channel terms risk

## Phase 2: Days 31-60

Must complete:

- finalize lawful basis table
- finalize RoPA
- implement DSAR workflow
- implement deletion workflow
- implement vendor review procedure
- complete cross-border transfer assessment
- create AI use register
- create prohibited-use and human oversight policy
- add accessibility backlog for public web assets

## Phase 3: Days 61-90

Must complete:

- tabletop breach exercise
- backup/restore test
- access review
- privacy and security training for staff
- public security overview
- customer-facing security questionnaire pack
- first internal compliance audit against this document

## Phase 4: Next 6-12 Months

Evaluate:

- SOC 2 readiness
- ISO 27001 readiness
- PCI scoping if payments are added
- CCPA readiness if US expansion justifies it
- formal external counsel review per market
- AI Act delta analysis as enforcement dates mature

## Suggested Document Set To Create

Internal:

- RoPA
- data flow map
- lawful basis register
- vendor register
- subprocessor register
- transfer impact assessment template
- DPIA template
- incident response plan
- breach notification checklist
- retention and deletion policy
- access control policy
- secure development policy
- AI governance policy
- acceptable use and prohibited-use policy

External:

- Terms of Service / MSA
- Privacy Notice
- Cookie Notice
- DPA
- Subprocessor List
- Security Overview
- AI Transparency Notice

## Practical Position On The Screenshot Badges

If you need to prioritize spend and time:

- do GDPR, DPA, SCC/TIA, retention, DSAR, security, and AI governance first
- do accessibility early if you have a public product surface
- do SOC 2 when enterprise sales start asking repeatedly
- do PCI only when payments are in scope
- do CCPA only when California exposure becomes real
- ignore BBB unless there is a specific commercial reason

## Definition Of Done For "Defensible Compliance"

You are not "done" when the docs are written.

You are reasonably defensible when:

- each major processing activity has an owner
- each major vendor has a signed contract and transfer basis
- customers can see your privacy and security position
- rights requests can be handled operationally
- breaches can be escalated and assessed within regulatory deadlines
- retention exists in code and operations, not just in policy
- AI behavior is disclosed, governed, and reviewable
- evidence exists for all of the above

## Official Source References

- GDPR: https://eur-lex.europa.eu/eli/reg/2016/679/oj
- EU AI Act: https://eur-lex.europa.eu/eli/reg/2024/1689/
- NIS2: https://eur-lex.europa.eu/eli/dir/2022/2555/en
- ePrivacy Directive: https://eur-lex.europa.eu/eli/dir/2002/58/oj
- European Accessibility Act: https://eur-lex.europa.eu/eli/dir/2019/882
- WCAG 2.2: https://www.w3.org/TR/wcag/
- SCCs: https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/standard-contractual-clauses-scc_en
- Controller/processor SCC package: https://commission.europa.eu/publications/standard-contractual-clauses-controllers-and-processors-eueea_en
- PCI DSS SAQ overview: https://www.pcisecuritystandards.org/faq/articles/Frequently_Asked_Question/what-is-a-pci-dss-self-assessment-questionnaire/
- CCPA overview: https://www.oag.ca.gov/privacy/ccpa
- SOC 2 overview: https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2
- Data Privacy Framework overview: https://www.dataprivacyframework.gov/Program-Overview
