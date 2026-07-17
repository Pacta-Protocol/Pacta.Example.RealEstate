'use strict';
// The demo scenario, in one place: a US development consortium is buying
// coastal land in Guanacaste, Costa Rica, and needs three local professional
// services to close - title study, cadastral survey, transfer deed. Trust is
// the whole problem: the buyer is 4,000 km away and cannot "ask a colleague"
// about a Costa Rican surveyor. Pacta's stake-based vetting and registry
// verification replace that missing local knowledge.

const PROPERTY = {
  name: 'Finca Vista Pacífico',
  location: 'Playa Potrero, Guanacaste, Costa Rica',
  folio: 'Folio Real 5-102-334455',
  size: '4.2 ha (10.4 acres)',
  price_usd: 850_000,
  use: 'Eco-resort development (24 villas + beach club)',
  buyer: 'US development consortium',
  diligence_budget_usd: 6_000,
};

// Public-registry records the honest providers' filings verify against.
// (In production these are the Registro Nacional / Catastro Nacional APIs;
// the protocol ships a mock registry with the same semantics.)
const REGISTRY_RECORDS = [
  ['CR-RN-2026-511042', 'title_study',
    'Certificación literal - Finca 5-102-334455',
    'Registro Nacional de Costa Rica', 'Full title certificate with liens, annotations and easements for the Guanacaste property.'],
  ['CR-CN-2026-771204', 'cadastral_survey',
    'Plano catastrado 5-2026-771204',
    'Catastro Nacional de Costa Rica', 'Registered cadastral survey plan for Finca 5-102-334455.'],
  ['CR-RN-2026-448890', 'deed_registration',
    'Escritura de traspaso inscrita - tomo 2026, asiento 448890',
    'Registro Nacional de Costa Rica', 'Transfer deed registered in favor of the buyer entity.'],
];

// The reference a dishonest provider CLAIMS in its proof text. It does not
// exist in the registry - that is the point.
const FAKE_SURVEY_REF = 'CR-CN-2026-999999';

// Provider lineup. AgriMensura Express is the trap: cheapest, spotless
// rating, vetted - but its offer steps carry no registry anchoring, and the
// "plano" it delivers cites a filing reference the Catastro has never seen.
// Its stake is sized so that losing the dispute wipes it out entirely
// (stake = 20% of price = the refund-ruling slash), which also puts its
// exposure cap (5x stake) exactly at its offer price.
const SMBS = [
  {
    key: 'registral',
    name: 'Registral Firme S.A.', category: 'title-study', location: 'Liberia, Guanacaste, Costa Rica',
    description: 'Title research firm specializing in coastal and maritime-zone properties.',
    capabilities: 'title study, folio real, lien search, annotations, easements, registro nacional',
    stake_cents: 2_000_00, rating: { good: 4, bad: 0 },
    offer: {
      title: 'Full title study & lien search (Registro Nacional)',
      description: 'Complete due-diligence title study for one property: registry certificate, lien/annotation/easement analysis, and a written report in English.',
      price_cents: 1_450_00, upfront_pct: 30,
      steps: [
        ['Pull registry certificate', 'Obtain the certificación literal for the folio real from the Registro Nacional.', 'title_study'],
        ['Analyze liens, annotations and easements', 'Review every entry affecting the property and flag risks.', null],
        ['Deliver title report', 'Written report in English with a clear go/no-go recommendation.', null],
      ],
    },
  },
  {
    key: 'titulo_economico',
    name: 'Despacho Título Económico', category: 'title-study', location: 'San José, Costa Rica',
    description: 'Budget title-search practice. Registered on the marketplace but has never posted a stake.',
    capabilities: 'title search, registry lookup',
    stake_cents: 0, rating: { good: 1, bad: 0 },
    offer: {
      title: 'Basic title lookup (budget)',
      description: 'Quick registry lookup and summary. No formal report.',
      price_cents: 1_100_00, upfront_pct: 50,
      steps: [['Registry lookup', 'Pull the folio real and summarize.', null]],
    },
  },
  {
    key: 'agrimensura',
    name: 'AgriMensura Express', category: 'survey', location: 'Santa Cruz, Guanacaste, Costa Rica',
    description: 'Fast, low-cost land surveying. Digital delivery within days.',
    capabilities: 'land survey, topography, plano catastrado, boundaries, fast delivery',
    stake_cents: 136_00, rating: { good: 5, bad: 0 },
    offer: {
      title: 'Express land survey with digital plano (fast delivery)',
      description: 'Boundary survey of the parcel with a digital survey plan delivered by email.',
      price_cents: 680_00, upfront_pct: 50,
      steps: [
        ['Field survey of the parcel', 'Measure boundaries and landmarks on site.', null],
        ['Deliver digital survey plan', 'Survey plan (plano) delivered as PDF with the filing reference.', null],
      ],
    },
  },
  {
    key: 'geodesia',
    name: 'Geodesia Guanacaste S.A.', category: 'survey', location: 'Nicoya, Guanacaste, Costa Rica',
    description: 'Licensed surveyors. Every plano catastrado is registered at the Catastro Nacional before delivery.',
    capabilities: 'cadastral survey, plano catastrado, catastro nacional registration, licensed topographer',
    stake_cents: 1_500_00, rating: { good: 3, bad: 1 },
    offer: {
      title: 'Certified cadastral survey registered at Catastro Nacional',
      description: 'Full cadastral survey with the plano catastrado registered at the Catastro Nacional - the registration reference is the deliverable.',
      price_cents: 1_480_00, upfront_pct: 30,
      steps: [
        ['Field survey of the parcel', 'Licensed topographer measures the parcel.', null],
        ['Register plano catastrado', 'File and register the survey plan at the Catastro Nacional.', 'cadastral_survey'],
        ['Deliver certified plano', 'Certified copy with registration reference, in English and Spanish.', null],
      ],
    },
  },
  {
    key: 'notaria',
    name: 'Notaría Chaves & Mora', category: 'notary', location: 'Tamarindo, Guanacaste, Costa Rica',
    description: 'Notarial practice handling property transfers for foreign buyers.',
    capabilities: 'notary, escritura, transfer deed, deed registration, closing, foreign buyers',
    stake_cents: 3_000_00, rating: { good: 4, bad: 1 },
    offer: {
      title: 'Transfer deed drafting & registration (escritura)',
      description: 'Draft the escritura de traspaso, execute before a notary public, and register the transfer at the Registro Nacional.',
      price_cents: 2_200_00, upfront_pct: 25,
      steps: [
        ['Draft escritura de traspaso', 'Transfer deed drafted for the buyer entity.', null],
        ['Register deed at Registro Nacional', 'Execute and register the transfer; registration reference is the proof.', 'deed_registration'],
        ['Deliver registered testimonio', 'Certified copy of the registered deed.', null],
      ],
    },
  },
];

// What each honest provider's back office files at the authorities, keyed by
// verification kind. The market simulator uses this to complete steps.
const RECEIPTS = {
  title_study: 'CR-RN-2026-511042',
  cadastral_survey: 'CR-CN-2026-771204',
  deed_registration: 'CR-RN-2026-448890',
};

const AGENT_NAME = 'LandBridge Acquisition Agent';
const AGENT_BALANCE_CENTS = 50_000_00;
const ARBITER_NAME = 'Cámara Costarricense de Arbitraje';
const BAD_PROVIDER = 'AgriMensura Express';

module.exports = {
  PROPERTY, REGISTRY_RECORDS, FAKE_SURVEY_REF, SMBS, RECEIPTS,
  AGENT_NAME, AGENT_BALANCE_CENTS, ARBITER_NAME, BAD_PROVIDER,
};
