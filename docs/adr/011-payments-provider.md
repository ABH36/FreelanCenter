# ADR-011: Payments - Razorpay behind a `PaymentProvider` interface

**Status:** Proposed (Owner ratification, D4; Spike D not executed) · **Date:** 2026-09-21 · **SRS:** 6.10, 6.11, C15, D4, D6

## Context

Indian creators need payouts and the platform needs subscriptions. Secondary sources say Stripe Connect is unavailable to Indian-incorporated platforms without an invite or a foreign entity (low-medium confidence, not from Stripe); Razorpay Route supports split payments to linked accounts in INR.

## Decision (working assumption)

Razorpay (Route for marketplace splits, Subscriptions for plans) behind `PaymentProvider`. v1 is India/INR-first. Stripe is added only if the Owner has a foreign entity and wants international payments.

## Not verified

Route activation requirements, settlement holds (for the 14-day payout hold), refund/chargeback mechanics, GST invoicing, subscription proration/dunning. See [SPIKE_D_PAYMENTS.md](../spikes/SPIKE_D_PAYMENTS.md). **No payment code before Phase 6**; ratify this ADR before then.
