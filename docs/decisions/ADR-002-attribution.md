# ADR-002: Attribution rules

**Status:** accepted · 2026-10-08

## Context

The business needs to say which marketing produced which lending and what it cost. Salesforce Lead Source is typed by people and is wrong or blank about half the time. The data available is: ad spend by campaign and week, website and email touches keyed by an anonymous id, referral introductions, and the Salesforce funnel.

## Decisions

1. **Identity before attribution.** Anonymous ids become people only through recorded links with a method and a confidence; links under 0.75 are ignored. The weakest method (`crm_match`) is 0.8.
2. **One journey per opportunity, 90-day lookback.** Touches of the contact up to the enquiry. Firm-level touches are not used; two solicitors at one firm are two people.
3. **Credit goes to actions, not exposure.** Clicks, visits, opens, event attendance, referral introductions and the form itself earn credit. Impressions earn credit only when a journey has nothing else.
4. **Five models, always side by side.** No single model is "the truth". First touch answers "what starts journeys", last touch "what closes them", position-based is the default for cost per funded loan because it rewards both.
5. **Unattributed is a number, not a guess.** Journeys with no resolvable touch are reported as a share. The weekly report falls back to normalised Lead Source for those rows and labels the fallback.
6. **Referral commission is a channel cost.** 2% of funded principal, so the referral channel is comparable with paid media on cost per funded loan.

## Consequences

- The engine never writes a channel back into Salesforce; it publishes the comparison instead. A Salesforce field for "attributed channel" would be specified for the engineering team once the model is agreed with the marketer.
- Changing a model or the lookback is one line and a full recompute (idempotent, nightly).
