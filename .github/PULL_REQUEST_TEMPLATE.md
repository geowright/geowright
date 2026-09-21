<!-- Thank you. The ground rules are short: CONTRIBUTING.md. -->

## What and why


## Checklist
- [ ] Every commit is signed off (`git commit -s`, DCO — see CONTRIBUTING.md)
- [ ] Real input only: no `map.fire()`, no synthetic DOM events; public map-library API only in the adapter
- [ ] No network in tests: whatever a page fetches is answered from fixtures in the repository
- [ ] A test that fails without the change; `npx playwright test` and `npm run typecheck` pass
- [ ] No fixed sleeps, no retries. For a change to waiting or input: `npx playwright test <spec> --repeat-each=20` on a quiet machine
- [ ] API change → README (API reference) and CHANGELOG.md updated
- [ ] New third-party material → permissive license, license file kept, a row in `docs/THIRD_PARTY_NOTICES.md` or `wild/fixtures/SOURCES.md`
