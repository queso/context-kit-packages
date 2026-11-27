# Stripe fixtures

These JSON files are Stripe's own published example objects, copied unchanged
from `openapi/fixtures3.json` in https://github.com/stripe/openapi at commit
`a045100cf4af0acb548cb9c6f236bb117f83458f` (spec version `2026-09-30.endive`,
the same major release as the pinned `2026-10-28.endive`). stripe-mock serves
the same fixtures.

They are not recordings from a Stripe account. The fake Stripe server in
`../../helpers/fake-stripe.ts` starts every object from one of these files and
overrides only the fields a test cares about, so the rest of each payload keeps
Stripe's real shape. The live suite in `src/__live__` checks the same flows
against a real sandbox.
