'use strict';

/**
 * Generates free-text inbound enquiries (web form / email) with ground-truth
 * labels and a human decision for each. The truth route is computed by the
 * SAME coded rules the AI layer uses, so the rules are the authority and the
 * only thing being evaluated in shadow mode is the model's reading of the text.
 */

const { applyRules } = require('./ai-layer/rules');
const { ymd, addDays, iso } = require('../lib/dates');

const COURTS = ['the Central Family Court', 'the Family Court at Manchester', 'the Family Court at Birmingham', 'the Family Court at Leeds', 'Bristol Family Court', 'the Family Court sitting at Cardiff'];
const PROBATE_TOWNS = ['Reading', 'Guildford', 'Harrogate', 'Cheltenham', 'St Albans', 'Chester', 'Bath', 'Winchester'];
const SIGNOFFS = ['Kind regards', 'Best regards', 'Many thanks', 'Regards', 'Thanks'];
const REVIEWERS = ['Sarah Okonjo', 'Michael Brandt', 'Leila Haddad'];

const fmtGbp = (n, rng) => {
  const style = rng.weighted({ full: 0.7, k: 0.25, words: 0.05 });
  if (style === 'k' && n >= 1000) return `£${Math.round(n / 1000)}k`;
  if (style === 'words') return `around ${(n / 1000).toFixed(0)} thousand pounds`;
  return `£${n.toLocaleString('en-GB')}`;
};
const round500 = (n) => Math.round(n / 500) * 500;
const longDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });

function generate(rng, { firms, worldEnd, count }) {
  const ew = firms.filter((f) => f.jurisdiction === 'England and Wales');
  const enquiries = [];
  const labels = [];
  const humans = [];

  const firmLookup = (name) => {
    if (!name) return null;
    const n = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return firms.find((f) => f.name.toLowerCase().replace(/[^a-z0-9]+/g, '') === n) || null;
  };

  for (let i = 0; i < count; i++) {
    const receivedAt = addDays(worldEnd, -rng.float() * 56);
    const scenario = rng.weighted({
      family_standard: 0.33,
      probate_standard: 0.27,
      probate_executor: 0.06,
      family_no_solicitor: 0.06,
      scotland: 0.05,
      below_min: 0.04,
      above_max: 0.03,
      insufficient_security: 0.05,
      missing_amount: 0.04,
      other_matter: 0.04,
      vague: 0.03,
    });
    const firm = rng.pick(ew);
    const person = `${rng.pick(['Priya', 'James', 'Amelia', 'Tom', 'Rachel', 'Daniel', 'Hannah', 'Oliver', 'Fatima', 'Kwame', 'Elena', 'Marcus'])} ${rng.pick(['Nandakumar', 'Hartley', 'Okafor', 'Whitlock', 'Mercer', 'Petrova', 'Rahman', 'Walsh', 'Bianchi', 'Chaudhry'])}`;
    const role = rng.pick(['Partner', 'Senior Associate', 'Solicitor', 'Head of Family', 'Private Client Solicitor', 'Associate']);
    const channel = rng.weighted({ web_form: 0.55, email: 0.4, phone_note: 0.05 });
    const hearingDays = rng.chance(0.55) ? rng.int(5, 120) : null;
    const hearingDate = hearingDays ? longDate(addDays(receivedAt, hearingDays)) : null;
    const signoff = `${rng.pick(SIGNOFFS)},\n${person}\n${role}, ${firm.name}`;

    // truth
    const t = { product: 'family_law', jurisdiction: 'England and Wales', requested_gbp: null, security_gbp: null, hearing_in_days: hearingDays, has_solicitor: true, solicitor_firm: firm.name };
    let text = '';
    let subject = '';

    switch (scenario) {
      case 'family_standard': {
        t.requested_gbp = round500(rng.lognormal(32000, 0.5));
        t.security_gbp = round500(t.requested_gbp * rng.lognormal(12, 0.6));
        const side = rng.pick(['the wife', 'the husband', 'the applicant', 'the respondent', 'my client, the wife,', 'the mother']);
        const variants = [
          `Good ${rng.pick(['morning', 'afternoon'])},\n\nI act for ${side} in financial remedy proceedings at ${rng.pick(COURTS)}. The matrimonial assets are approximately ${fmtGbp(t.security_gbp, rng)}, mostly the family home and ${rng.pick(['a pension', 'two buy-to-let properties', 'the husband\'s business', 'investments held in the husband\'s sole name'])}. My client has no access to funds at present. ${hearingDate ? `The ${rng.pick(['FDR', 'final hearing', 'first appointment'])} is listed for ${hearingDate}. ` : ''}We estimate costs to ${rng.pick(['final hearing', 'the FDR', 'conclusion'])} at ${fmtGbp(t.requested_gbp, rng)}. Could you confirm whether Lodestar could assist and what you would need from us?\n\n${signoff}`,
          `Hello,\n\nEnquiry re a litigation loan for ${side} in a divorce. Assets in dispute roughly ${fmtGbp(t.security_gbp, rng)} (property and pensions). ${hearingDate ? `Next hearing ${hearingDate} at ${rng.pick(COURTS)}. ` : ''}Funding required: ${fmtGbp(t.requested_gbp, rng)} for counsel, a forensic accountant and our own costs. Please send your criteria and application form.\n\n${signoff}`,
          `Dear Lodestar team,\n\nWe have a client in ongoing matrimonial proceedings who needs to fund her representation. The pot is about ${fmtGbp(t.security_gbp, rng)}; the other side controls the liquid assets. ${hearingDate ? `There is a hearing on ${hearingDate}. ` : ''}We would be looking at ${fmtGbp(t.requested_gbp, rng)} to cover the matter through to settlement or trial. Is this something you can look at this week?\n\n${signoff}`,
        ];
        text = rng.pick(variants);
        subject = rng.pick(['Litigation funding enquiry', 'Financial remedy proceedings – funding', `Funding for ${side.replace('my client, ', '')} – ${firm.name}`]);
        break;
      }
      case 'probate_standard': {
        t.product = 'probate';
        t.security_gbp = round500(rng.lognormal(650000, 0.5));
        t.requested_gbp = round500(Math.min(t.security_gbp * 0.3, rng.lognormal(60000, 0.6)));
        const town = rng.pick(PROBATE_TOWNS);
        const purpose = rng.pick(['the inheritance tax due before the grant can issue', 'IHT and our fees pending the grant of probate', 'the IHT liability, which must be paid before we can apply for the grant', 'professional fees and tax while the house is sold']);
        const variants = [
          `Hi,\n\nWe are administering an estate in ${town} with a gross value of about ${fmtGbp(t.security_gbp, rng)}, almost entirely the deceased's home. There is very little cash. The executors need ${fmtGbp(t.requested_gbp, rng)} to cover ${purpose}. ${hearingDate ? `The tax is due by ${hearingDate}. ` : ''}Could you let us know your terms and how quickly funds can be released?\n\n${signoff}`,
          `Good ${rng.pick(['morning', 'afternoon'])},\n\nProbate loan enquiry. Estate valued at ${fmtGbp(t.security_gbp, rng)} (residential property plus a small portfolio). Executors require ${fmtGbp(t.requested_gbp, rng)} for ${purpose}. Grant expected within ${rng.int(6, 16)} weeks. We act for the executors.\n\n${signoff}`,
          `Dear Sir or Madam,\n\nI am instructed by the executors of a ${town} estate worth approximately ${fmtGbp(t.security_gbp, rng)}. The estate is illiquid and ${fmtGbp(t.requested_gbp, rng)} is needed for ${purpose}. ${hearingDate ? `HMRC's deadline is ${hearingDate}. ` : ''}Please advise on the process.\n\n${signoff}`,
        ];
        text = rng.pick(variants);
        subject = rng.pick(['Probate loan enquiry', 'Estate funding – IHT', `Executor funding – ${town} estate`]);
        break;
      }
      case 'probate_executor': {
        t.product = 'probate';
        t.security_gbp = round500(rng.lognormal(550000, 0.4));
        t.requested_gbp = round500(Math.min(t.security_gbp * 0.3, rng.lognormal(50000, 0.5)));
        const town = rng.pick(PROBATE_TOWNS);
        text = `Hello,\n\nI'm the executor named in my late ${rng.pick(['father', 'mother', 'aunt'])}'s will. The estate is mostly the house in ${town}, valued at around ${fmtGbp(t.security_gbp, rng)}, with very little cash in the bank. I need to pay about ${fmtGbp(t.requested_gbp, rng)} in inheritance tax before the grant can be issued. My solicitors are ${firm.name} and they suggested I contact you. How quickly can this be arranged and what do you need from me?\n\nThanks,\n${person.split(' ')[0]}`;
        subject = 'Help paying inheritance tax before probate';
        break;
      }
      case 'family_no_solicitor': {
        t.has_solicitor = false;
        t.solicitor_firm = null;
        t.requested_gbp = round500(rng.lognormal(25000, 0.4));
        t.security_gbp = round500(t.requested_gbp * rng.lognormal(10, 0.5));
        text = `Hi there,\n\nI am going through a divorce and representing myself at the moment because I can't afford a solicitor. My ex has all the money (the house and his pension are worth about ${fmtGbp(t.security_gbp, rng)}). ${hearingDate ? `I have a hearing on ${hearingDate}. ` : ''}I think I'd need around ${fmtGbp(t.requested_gbp, rng)} to get proper representation. Can you lend to me directly?\n\n${person.split(' ')[0]}`;
        subject = 'Loan for my divorce';
        break;
      }
      case 'scotland': {
        t.jurisdiction = 'Scotland';
        t.requested_gbp = round500(rng.lognormal(30000, 0.4));
        t.security_gbp = round500(t.requested_gbp * 10);
        const scotFirm = `${rng.pick(['Macrae', 'Buchanan', 'Lennox', 'Drummond'])} & ${rng.pick(['Stewart', 'Fraser', 'Reid'])} Solicitors`;
        t.solicitor_firm = scotFirm;
        text = `Good morning,\n\nWe act for the pursuer in a financial provision action at ${rng.pick(['Edinburgh Sheriff Court', 'Glasgow Sheriff Court', 'the Court of Session'])}. Matrimonial property is around ${fmtGbp(t.security_gbp, rng)}. Our client needs ${fmtGbp(t.requested_gbp, rng)} to fund the action to proof. Do you lend in Scotland?\n\nRegards,\n${person}\n${role}, ${scotFirm}, Edinburgh`;
        subject = 'Funding – financial provision action';
        break;
      }
      case 'below_min': {
        t.requested_gbp = rng.pick([2000, 2500, 3000, 3500, 4000]);
        t.security_gbp = round500(rng.lognormal(200000, 0.4));
        text = `Hello,\n\nSmall one: our client in a children and finance matter at ${rng.pick(COURTS)} needs ${fmtGbp(t.requested_gbp, rng)} to cover a single counsel's fee for ${hearingDate ? `the hearing on ${hearingDate}` : 'an upcoming hearing'}. Assets in the case are about ${fmtGbp(t.security_gbp, rng)}. Is that within your minimum?\n\n${signoff}`;
        subject = 'Short-term funding for counsel\'s fee';
        break;
      }
      case 'above_max': {
        t.product = 'probate';
        t.security_gbp = round500(rng.lognormal(4500000, 0.3));
        t.requested_gbp = round500(rng.int(550000, 900000) / 1);
        text = `Dear Lodestar,\n\nWe are dealing with a substantial estate (approx. ${fmtGbp(t.security_gbp, rng)}, largely commercial property and a farm). The executors face an IHT bill of ${fmtGbp(t.requested_gbp, rng)} and the assets cannot be realised in time. Can you consider a facility of that size?\n\n${signoff}`;
        subject = 'Large estate – IHT facility';
        break;
      }
      case 'insufficient_security': {
        t.requested_gbp = round500(rng.int(20000, 45000));
        t.security_gbp = round500(t.requested_gbp * rng.float() * 1.2 + 5000);
        text = `Hi,\n\nFinancial remedy case at ${rng.pick(COURTS)}. The only real asset is a flat with equity of about ${fmtGbp(t.security_gbp, rng)}; everything else is debt. My client needs ${fmtGbp(t.requested_gbp, rng)} to get to a final hearing${hearingDate ? ` on ${hearingDate}` : ''}. I appreciate the numbers are tight. Would you look at it?\n\n${signoff}`;
        subject = 'Funding – limited assets';
        break;
      }
      case 'missing_amount': {
        t.product = rng.chance(0.5) ? 'probate' : 'family_law';
        t.security_gbp = round500(rng.lognormal(t.product === 'probate' ? 500000 : 800000, 0.4));
        text = t.product === 'probate'
          ? `Hello,\n\nWe have an estate of roughly ${fmtGbp(t.security_gbp, rng)} where the executors will need to borrow against the property to settle tax and fees. We don't yet have the final IHT computation so I can't give you a figure. Could you send over your criteria and an indication of pricing so we can discuss with the executors?\n\n${signoff}`
          : `Good afternoon,\n\nWe may need funding for a client in matrimonial proceedings. Assets are in the region of ${fmtGbp(t.security_gbp, rng)}. We are at an early stage and have not costed the matter yet. What information do you need to give an indicative decision?\n\n${signoff}`;
        subject = 'Initial enquiry – criteria and pricing';
        break;
      }
      case 'other_matter': {
        t.product = 'other';
        t.requested_gbp = round500(rng.lognormal(40000, 0.5));
        t.security_gbp = null;
        const matter = rng.pick(['a personal injury claim following a road traffic accident', 'a commercial dispute over an unpaid contract', 'an employment tribunal claim for unfair dismissal', 'a professional negligence claim against a surveyor']);
        text = `Hi,\n\nWe act for the claimant in ${matter}. The claim is valued at a multiple of the funding needed. Our client requires ${fmtGbp(t.requested_gbp, rng)} for disbursements and counsel. Do you fund this type of case?\n\n${signoff}`;
        subject = 'Litigation funding – ' + matter.split(' ').slice(0, 3).join(' ');
        break;
      }
      case 'vague': {
        t.product = 'unclear';
        t.jurisdiction = 'unclear';
        t.requested_gbp = null;
        t.security_gbp = null;
        t.has_solicitor = rng.chance(0.5);
        if (!t.has_solicitor) t.solicitor_firm = null;
        text = rng.pick([
          `Hi, do you do loans for legal cases? How much can I borrow and what are the rates? Thanks`,
          `Hello,\n\nA colleague mentioned you. Could someone call me about funding options for a client? Best number is ${rng.int(7000, 7999)} ${rng.int(100000, 999999)}.\n\n${t.has_solicitor ? signoff : person}`,
          `Looking for info on litigation loans, please send brochure.`,
        ]);
        subject = rng.pick(['Question', 'Loans', 'Info request']);
        break;
      }
      default:
        break;
    }

    const enquiryId = `ENQ-${String(26000 + i + 1)}`;
    const truthRules = applyRules(t, { firmLookup });
    enquiries.push({
      enquiry_id: enquiryId,
      received_at: iso(receivedAt),
      channel,
      from_name: t.has_solicitor ? person : person.split(' ')[0],
      from_email: t.has_solicitor ? `${person.split(' ')[0].toLowerCase()}.${person.split(' ')[1].toLowerCase()}@${(firmLookup(t.solicitor_firm) || firm).website_domain}` : `${person.split(' ')[0].toLowerCase()}${rng.int(10, 99)}@example.com`,
      firm_id: null,
      subject,
      raw_text: text,
    });
    labels.push({
      enquiry_id: enquiryId,
      product: t.product,
      jurisdiction: t.jurisdiction,
      requested_gbp: t.requested_gbp,
      security_gbp: t.security_gbp,
      hearing_in_days: t.hearing_in_days,
      route: truthRules.route,
    });

    // The human decision: usually the rules' answer, with realistic human variance.
    let humanRoute = truthRules.route;
    let notes = null;
    if (rng.chance(0.07)) {
      if (humanRoute === 'needs_more_info') {
        humanRoute = t.product === 'probate' ? 'probate_team' : t.product === 'family_law' ? 'family_team' : 'decline';
        notes = 'Proceeded on a call; details confirmed verbally';
      } else if (humanRoute === 'decline') {
        humanRoute = 'needs_more_info';
        notes = 'Asked for more information before declining';
      } else {
        humanRoute = 'needs_more_info';
        notes = 'Wanted valuation evidence first';
      }
    }
    humans.push({
      enquiry_id: enquiryId,
      reviewer: rng.pick(REVIEWERS),
      route: humanRoute,
      product: truthRules.product,
      approved_gbp: humanRoute.endsWith('_team') ? truthRules.max_loan_gbp : null,
      decided_at: iso(addDays(receivedAt, rng.float() * 1.2 + 0.02)),
      notes,
    });
  }

  return { enquiries, labels, humans };
}

module.exports = { generate };
