// packs.js — credit pack definitions (source of truth for pricing)
const PACKS = {
  starter: { id: 'starter', label: 'Starter', priceUsd: 2,  credits: 10 },
  popular: { id: 'popular', label: 'Popular', priceUsd: 5,  credits: 35 },
  pro:     { id: 'pro',     label: 'Pro',     priceUsd: 10, credits: 100 },
  bulk:    { id: 'bulk',    label: 'Bulk',    priceUsd: 20, credits: 250 },
};

module.exports = { PACKS };
