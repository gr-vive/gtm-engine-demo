'use strict';

/**
 * Coded rules for inbound enquiry triage.
 *
 * Division of labour, by design:
 *   - the model READS the free text and fills in fields (extract.js)
 *   - these RULES make the routing decision and do the arithmetic
 *   - a PERSON makes the judgement call (human_decisions / review_queue)
 *
 * Rules are pure: same input, same output, no I/O. Every rule that fires is
 * returned with its outcome so the audit log can show exactly why a case was
 * routed the way it was. Change the version string whenever behaviour changes.
 */

const config = require('../../lib/config');

// v3 (2026-10-08): R01 infers jurisdiction from the instructed firm when the text
// does not state it. Shadow mode on rules-v2 showed 46 of 240 cases where the model
// correctly reported "not stated" and people proceeded because they knew the firm.
const RULES_VERSION = 'rules-v3';
const ROUTES = ['family_team', 'probate_team', 'decline', 'needs_more_info'];

/**
 * @param {object} x extracted fields (see extract.js for the schema)
 * @param {object} ctx { firmLookup(name) -> firm | null }  firm has { firm_id, name, on_panel, jurisdiction }
 */
function applyRules(x, ctx = {}) {
  const fired = [];
  const flags = [];
  let decline = null;
  let more = null;
  let maxLoan = null;
  let priority = 'normal';
  const fire = (rule, outcome, detail) => fired.push({ rule, outcome, detail });

  // The firm, if the model named one and we know it. Used by R01 and R08.
  const firm = x.has_solicitor && x.solicitor_firm && ctx.firmLookup ? ctx.firmLookup(x.solicitor_firm) : null;

  // R01 jurisdiction: we lend in England and Wales only. If the text does not say,
  // a known firm's jurisdiction stands in; an unknown firm means we have to ask.
  let jurisdiction = x.jurisdiction;
  let inferred = false;
  if ((!jurisdiction || jurisdiction === 'unclear') && firm && firm.jurisdiction) {
    jurisdiction = firm.jurisdiction;
    inferred = true;
  }
  if (jurisdiction === 'England and Wales') fire('R01_jurisdiction', inferred ? 'pass_inferred_from_firm' : 'pass', inferred ? `${firm.name} is in ${jurisdiction}` : jurisdiction);
  else if (!jurisdiction || jurisdiction === 'unclear') {
    more = more || 'jurisdiction_unclear';
    fire('R01_jurisdiction', 'needs_more_info', 'jurisdiction not stated and firm not known');
  } else {
    decline = 'outside_jurisdiction';
    fire('R01_jurisdiction', 'decline', inferred ? `${firm.name} is in ${jurisdiction}` : jurisdiction);
  }

  // R02 product: family law or probate; anything else is outside our products.
  const product = x.product;
  const spec = config.LENDER.products[product];
  if (spec) fire('R02_product', 'pass', product);
  else if (product === 'other') {
    decline = decline || 'outside_products';
    fire('R02_product', 'decline', 'matter type not family law or probate');
  } else {
    more = more || 'product_unclear';
    fire('R02_product', 'needs_more_info', 'could not tell family law from probate');
  }

  // R03 solicitor: funding is paid to and managed through the instructed solicitor.
  if (x.has_solicitor) fire('R03_solicitor', 'pass', x.solicitor_firm || 'firm not named');
  else {
    more = more || 'no_solicitor_instructed';
    fire('R03_solicitor', 'needs_more_info', 'no solicitor instructed');
  }

  // R04 amount present
  if (x.requested_gbp == null) {
    more = more || 'amount_missing';
    fire('R04_amount_present', 'needs_more_info', 'no amount stated');
  } else fire('R04_amount_present', 'pass', x.requested_gbp);

  // R05 product bounds
  if (spec && x.requested_gbp != null) {
    if (x.requested_gbp < spec.min) {
      decline = decline || 'below_minimum';
      fire('R05_bounds', 'decline', `${x.requested_gbp} < minimum ${spec.min}`);
    } else if (x.requested_gbp > spec.max) {
      more = more || 'above_maximum_refer_to_credit';
      fire('R05_bounds', 'needs_more_info', `${x.requested_gbp} > maximum ${spec.max}, credit committee`);
    } else fire('R05_bounds', 'pass', `${spec.min} ≤ ${x.requested_gbp} ≤ ${spec.max}`);
  }

  // R06 security arithmetic: the loan is capped at a share of the estate / assets in dispute.
  if (spec && x.requested_gbp != null) {
    if (x.security_gbp == null) {
      more = more || 'security_missing';
      fire('R06_security', 'needs_more_info', product === 'probate' ? 'estate value not stated' : 'assets in dispute not stated');
    } else {
      const cap = Math.round(x.security_gbp * spec.max_ltv);
      maxLoan = Math.min(x.requested_gbp, cap);
      if (maxLoan < spec.min) {
        decline = decline || 'insufficient_security';
        fire('R06_security', 'decline', `cap ${cap} = ${x.security_gbp} × ${spec.max_ltv} is below minimum ${spec.min}`);
      } else if (maxLoan < x.requested_gbp) {
        flags.push('reduced_to_ltv_cap');
        fire('R06_security', 'pass_reduced', `requested ${x.requested_gbp}, cap ${cap} = ${x.security_gbp} × ${spec.max_ltv}`);
      } else fire('R06_security', 'pass', `cap ${cap} ≥ requested ${x.requested_gbp}`);
    }
  }

  // R07 urgency: a hearing inside 14 days jumps the queue.
  if (x.hearing_in_days != null && x.hearing_in_days <= 14) {
    priority = 'high';
    fire('R07_urgency', 'priority_high', `hearing in ${x.hearing_in_days} days`);
  } else fire('R07_urgency', 'normal', x.hearing_in_days == null ? 'no hearing date' : `hearing in ${x.hearing_in_days} days`);

  // R08 panel: known referral partners are fast-tracked; unknown firms need onboarding.
  if (x.has_solicitor && x.solicitor_firm && ctx.firmLookup) {
    if (firm && firm.on_panel) fire('R08_panel', 'fast_track', firm.name);
    else if (firm) fire('R08_panel', 'known_firm', firm.name);
    else {
      flags.push('panel_onboarding_required');
      fire('R08_panel', 'onboarding', x.solicitor_firm);
    }
  }

  const route = decline ? 'decline' : more ? 'needs_more_info' : product === 'probate' ? 'probate_team' : 'family_team';
  return {
    version: RULES_VERSION,
    route,
    product: spec ? product : null,
    max_loan_gbp: route === 'decline' ? null : maxLoan,
    priority,
    reason: decline || more || 'eligible',
    flags,
    fired,
    firm_id: firm ? firm.firm_id : null,
  };
}

module.exports = { applyRules, RULES_VERSION, ROUTES };
