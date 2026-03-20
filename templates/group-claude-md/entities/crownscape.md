## Entity: Crownscape (Landscaping)

### Sub-Entities
Each landscaping company is a pluggable operational unit — same brand, same Digital GM,
separate Jobber + QuickBooks + deal terms.

| Sub-Entity | Legal Name | Status | Crews | Jobber Key | QB Account |
|-----------|-----------|--------|-------|-----------|------------|
| wise-gd | Wise GD Landscaping | Active | 1 crew of 3 | JOBBER_WISE_GD | Wise GD |
| icarelawncare | Crownscape LLC | Closing ~April 2026 | 8 crews of 2 | JOBBER_ICARE | TBD |

### Legal Structure
- **Wise GD Landscaping** (Great Dane Landscaping) — uses Crownscape brand, separate financial entity
  - SBA Loan: Bank of Tampa (acquired Jan 2025)
  - QuickBooks: "Wise GD" account
  - Jobber: own account (credential key: JOBBER_WISE_GD)
  - Currently: 1 crew of 3
- **Crownscape LLC** (FUTURE) — will hold ICARELAWNCARE acquisition (closing ~April 2026)
  - Post-close: 8 crews of 2 from ICARELAWNCARE
  - QuickBooks: new account TBD
  - Jobber: own account (credential key: JOBBER_ICARE)
- Parent chain: Wise Landscape Holdings → WiseStream LLC (CEO owns 100%)

### Business
- **Industry:** Landscaping — residential + commercial maintenance
- **Market:** Tampa Bay area
- **Brand:** Reliable, premium — "Your Property, Our Pride" (working tagline)
- **Stage:** Pre-acquisition — Wise GD operating, ICARELAWNCARE closing ~April 2026
- **Post-close total:** 1 GM + 19 crew members (1 crew of 3 + 8 crews of 2)

### Key Systems
**Brand-level (shared):** Google Workspace, Samsara (planned), CallRail, Google Ads, Zapier
**Per-sub-entity:** Jobber (own account each), QuickBooks (own account each)

### Cross-Entity
- GPG-managed properties default to Crownscape for landscaping unless owner has vendor preference
- Every new GPG management contract = potential Crownscape contract
