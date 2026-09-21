# ADR-012: Email and messaging

**Status:** Proposed · **Date:** 2026-09-21 · **SRS:** ADR-012 (SRS), FR-LEAD-03, FR-WL-03

## Decision (working assumption)

- **Transactional email:** Resend or Postmark from the platform's authenticated domain (SPF/DKIM/DMARC). Templates in React Email. Local development uses a capture inbox (e.g., Mailpit), never real sends.
- **White-label sending:** per-workspace verified sending domain or the freelancer's own SMTP; credentials envelope-encrypted (Phase 7A).
- **WhatsApp/SMS:** behind `WhatsAppProvider`; WhatsApp Cloud API for owner notifications. **India-specific risk:** transactional SMS in India requires sender/template registration under the regulator's DLT framework, and WhatsApp business messaging needs approved templates - both are lead-time items to verify before Phase 5.

## Not verified

No provider account was used in Phase 0. Choose provider and confirm India deliverability before Phase 5.
