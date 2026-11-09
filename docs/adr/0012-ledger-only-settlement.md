# ADR-0012: Ledger-only settlement with immutable payout batches

Status: **Accepted for MVP**  
Date: 2026-11-08

## Context

With settlement deferred, the MVP ledger had four account types and two posting recipes: capture and refund. The money-and-ledger contract was substantially larger than the accounting it actually performed, and the genuinely hard parts of double-entry bookkeeping — holding positions, batching, and proving a batch against its members — were not exercised anywhere.

Real bank rails are permanently out of scope for a sandbox project that holds no funds, so "settlement" here cannot mean a transfer.

## Decision

Add a settlement workflow that is entirely internal to the ledger.

Confirmed captures credit a merchant clearing position rather than a single available balance. Confirmed refunds debit it. A scheduled settlement run, for one merchant and currency, selects the eligible confirmed movements, posts **one balanced batch transaction** moving the net value from clearing to merchant payable, and records an immutable payout batch whose membership is fixed at posting time.

No value leaves the system. There is no bank integration, no file format, no external transfer, and no claim of payout capability.

## Consequences

- The ledger now holds clearing and payable positions, which is where double entry stops being decorative: a batch must balance against the exact set of movements it claims, and that assertion is a real invariant with a real test.
- Settlement is pure local logic with no provider in the path. It is fully testable offline and can be load tested, unlike a real provider adapter.
- Batch membership is immutable. A refund confirmed after a batch closes lands in the next batch; it never mutates a closed financial batch. This forces the contract to state what a negative net batch means and how it is carried.
- A second idempotent posting-key family is introduced (`settlement:{batchId}`), which exercises the posting-key contract against a non-payment-operation subject.
- The settlement run is a new durable work record with its own claim, lease, and sweeper, so it reuses the existing recovery model rather than inventing one.
- Adds a settlement module, tables, two events, and a worker process. This is the cost, and it buys the ledger depth that the contract already promised.

## Rejected alternatives

- **Keep settlement deferred:** leaves a 340-line ledger contract governing two posting recipes, and leaves the project's ledger claim thinner than its documentation implies.
- **Simulate bank files or an external payout API:** format and transport plumbing with no accounting design content, and it would reintroduce exactly the ambiguity-without-value problem that [ADR-0011](0011-simulated-providers-only-in-mvp.md) removes.
- **Net a late refund into its original closed batch:** requires mutating a committed financial batch, which the immutability contract forbids for good reason.
- **Settle each capture individually:** that is just the existing capture posting with extra steps; no batch, no membership proof, no interesting invariant.
- **Recognize the platform fee at settlement instead of capture:** contradicts [ADR-0008](0008-fee-recognized-at-capture.md) and makes any pre-settlement balance sheet wrong.
