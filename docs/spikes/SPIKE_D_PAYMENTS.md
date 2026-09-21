# Spike D - payments for Indian creators and subscriptions (Stripe Connect vs Razorpay)

**Status: NOT EXECUTED. Desk research only.** A real spike needs sandbox accounts (Razorpay test mode, Stripe test mode) and, for Route, activation by Razorpay. None was available. **Nothing below is a measurement, and the key claim rests on secondary sources.**

## What desk research found

| #   | Fact                                                                                                                                                          | Confidence                                                                                                                                                                                                                                           | Source                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| D-1 | Razorpay **Route** splits a payment among linked accounts (sellers), with fixed or percentage splits, automatic commission, transfers to vendor bank accounts | Medium-high (vendor page)                                                                                                                                                                                                                            | [Razorpay Route](https://razorpay.com/route/), [docs](https://razorpay.com/docs/payments/route/?preferred-country=IN) |
| D-2 | Razorpay supports INR only                                                                                                                                    | Medium (third-party summary of vendor docs)                                                                                                                                                                                                          | search summary                                                                                                        |
| D-3 | Sellers are onboarded as **Linked Accounts** (bank account + business category + address)                                                                     | Medium-high                                                                                                                                                                                                                                          | vendor docs via summaries                                                                                             |
| D-4 | **Stripe Connect is not available to Indian-incorporated platforms** without an invite or a foreign (e.g., US) entity                                         | **Low-medium: comes from a comparison blog ([Playto](https://www.playto.so/blogs/best-stripe-connect-alternative-for-indian-platform-and-marketplace-businesses-in-2026)), not from Stripe.** Verify with Stripe/Razorpay sales before relying on it | secondary                                                                                                             |

## Implications

- If D-4 holds, an India-incorporated platform selling to Indian creators must use **Razorpay (Route)** for marketplace payouts. This matches the Architect's recommendation and D4.
- INR-only means international freelancers cannot pay or be paid in other currencies through Razorpay. Decide whether v1 is India-only (recommended) or needs a second provider (Stripe requires a foreign entity per D-4).
- Plans (subscriptions) also need a provider: Razorpay Subscriptions is the natural choice; **not verified here**.

## To verify in a real spike (sandbox)

1. Route activation requirements and lead time for a marketplace business; linked-account KYC steps and rejection reasons.
2. Settlement timing to linked accounts and how the **14-day payout hold** (D6) is implemented (Route supports settlement holds? confirm).
3. Refund and chargeback handling for split payments (who bears it; reverse transfers).
4. Fees (payment, Route, payout), GST on platform commission, invoice generation.
5. Subscriptions: plan creation, proration/upgrades, dunning, webhook events; UPI autopay / cards; failed-payment retries.
6. Webhook signature verification and replay (SEC-06); idempotency keys.
7. Test-mode parity with production for all of the above.

## Decision status

ADR-011 = **Proposed: Razorpay behind `PaymentProvider`**, ratification by the Owner (D4) after items 1-3 are confirmed. No payment code is written before Phase 6.
