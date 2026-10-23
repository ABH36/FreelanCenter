# Module 1: Authentication & Identity Enhancements

**Status:** Critical Priority (Phase 1-2)  
**Current SRS Coverage:** FR-AUTH-01 to FR-AUTH-08  
**Missing Features:** FR-AUTH-09 to FR-AUTH-14

---

## Current State

### What Exists Today (FR-AUTH-01 to FR-AUTH-08)

- ✅ Email + password authentication with verified email
- ✅ Google OAuth integration
- ✅ Secure sessions (httpOnly, Secure, SameSite cookies)
- ✅ TOTP MFA (required for owners with payouts/white-label)
- ✅ Password reset via single-use tokens
- ✅ RBAC roles: PlatformAdmin, Owner, Admin, Editor, Viewer, Client
- ✅ Team invitations by email with role assignment
- ✅ Brute-force protection and rate limiting
- ✅ Multi-workspace membership support

### Current Flow

```
User → Sign Up → Email Verification → Login → MFA (if enabled) →
Session → Workspace Selection → Dashboard
```

---

## Missing Enterprise Features

### FR-AUTH-09: SAML 2.0 / OIDC SSO Integration

**Priority:** MUST (Phase 1)  
**Use Case:** Enterprise clients want to use their existing identity provider (Okta, Azure AD, OneLogin) for all SaaS applications.

### FR-AUTH-10: SCIM 2.0 Provisioning

**Priority:** SHOULD (Phase 5)  
**Use Case:** Automated user lifecycle management - when an employee leaves a company, their access should be automatically revoked across all SaaS apps.

### FR-AUTH-11: Hardware Key MFA (WebAuthn/FIDO2)

**Priority:** SHOULD (Phase 3)  
**Use Case:** Security-conscious enterprises prefer hardware keys (YubiKey) over TOTP apps.

### FR-AUTH-12: Device Fingerprinting & Geographic Anomaly Detection

**Priority:** MUST (Phase 1)  
**Use Case:** Detect suspicious login attempts from new devices or unusual locations.

### FR-AUTH-13: Enforceable Password Policies

**Priority:** SHOULD (Phase 2)  
**Use Case:** Enterprises require password complexity rules, rotation policies, and password history.

### FR-AUTH-14: Comprehensive Login Audit

**Priority:** MUST (Phase 1)  
**Use Case:** Detailed audit trail of all login attempts with IP geolocation, device details, success/failure status.

---

## Module Connections

### Upstream Dependencies

- **Workspace Management (Module 2):** SSO users need to be mapped to workspaces
- **RBAC System:** SSO groups need to map to platform roles
- **Audit Log (Module 16):** Login events need to be logged

### Downstream Dependencies

- **SCIM Provisioning:** Depends on SSO integration
- **Device Fingerprinting:** Used by security monitoring (Module 21)
- **Login Audit:** Used by admin console (Module 16)

---

## Detailed Flow Diagrams

### 1. SSO Login Flow (SAML 2.0)

```
┌─────────────────┐
│ Enterprise User │
└────────┬────────┘
         │ 1. Click "Login with SSO"
         ↓
┌─────────────────────────────────┐
│ Platform Dashboard (dashboard)  │
└────────┬────────────────────────┘
         │ 2. Redirect to IdP with SAML Request
         ↓
┌─────────────────────────────────┐
│ Identity Provider (Okta/Azure) │
│ - Authenticate user             │
│ - Verify group membership       │
│ - Generate SAML Response        │
└────────┬────────────────────────┘
         │ 3. POST SAML Response to ACS URL
         ↓
┌─────────────────────────────────┐
│ Platform SSO Handler            │
│ - Validate SAML signature       │
│ - Extract user attributes       │
│ - Check email domain mapping    │
│ - Create/update User record     │
│ - Map groups to roles           │
│ - Create session                │
└────────┬────────────────────────┘
         │ 4. Session created, redirect to dashboard
         ↓
┌─────────────────────────────────┐
│ Platform Dashboard              │
│ - User logged in                │
│ - Workspaces loaded             │
└─────────────────────────────────┘
```

### 2. SSO Login Flow (OIDC)

```
┌─────────────────┐
│ Enterprise User │
└────────┬────────┘
         │ 1. Click "Login with SSO"
         ↓
┌─────────────────────────────────┐
│ Platform Dashboard (dashboard)  │
└────────┬────────────────────────┘
         │ 2. Redirect to IdP with client_id, redirect_uri, scope, state
         ↓
┌─────────────────────────────────┐
│ Identity Provider (Okta/Azure) │
│ - Authenticate user             │
│ - User consents to scopes       │
│ - Generate authorization code   │
└────────┬────────────────────────┘
         │ 3. Redirect back with code
         ↓
┌─────────────────────────────────┐
│ Platform OIDC Handler          │
│ - Exchange code for tokens      │
│ - Validate ID token signature   │
│ - Extract user attributes       │
│ - Check email domain mapping    │
│ - Create/update User record     │
│ - Map groups to roles           │
│ - Create session                │
└────────┬────────────────────────┘
         │ 4. Session created, redirect to dashboard
         ↓
┌─────────────────────────────────┐
│ Platform Dashboard              │
│ - User logged in                │
│ - Workspaces loaded             │
└─────────────────────────────────┘
```

### 3. SCIM Provisioning Flow

```
┌─────────────────────────────────┐
│ Identity Provider (Okta/Azure) │
│ - User created/updated/deleted │
└────────┬────────────────────────┘
         │ 1. SCIM Request (POST/PUT/PATCH/DELETE)
         ↓
┌─────────────────────────────────┐
│ Platform SCIM Endpoint         │
│ - Validate Bearer token         │
│ - Check tenant mapping           │
│ - Parse SCIM payload            │
└────────┬────────────────────────┘
         │ 2. Process operation
         ↓
┌─────────────────────────────────┐
│ SCIM Provisioning Service       │
│ Case: CREATE                    │
│ - Check if user exists          │
│ - Create User record            │
│ - Map to default workspace      │
│ - Assign default role           │
│ - Send welcome email            │
│ Case: UPDATE                    │
│ - Update User attributes        │
│ - Sync role changes             │
│ - Update workspace memberships  │
│ Case: DELETE                    │
│ - Soft-delete User              │
│ - Revoke all sessions           │
│ - Notify workspace owners       │
└────────┬────────────────────────┘
         │ 3. Return SCIM response
         ↓
┌─────────────────────────────────┐
│ Identity Provider               │
│ - Record sync status            │
└─────────────────────────────────┘
```

### 4. Hardware Key MFA Flow (WebAuthn)

```
┌─────────────────┐
│ Enterprise User │
└────────┬────────┘
         │ 1. Navigate to Security Settings
         ↓
┌─────────────────────────────────┐
│ Platform Dashboard              │
│ - Show "Add Security Key" button│
└────────┬────────────────────────┘
         │ 2. Click "Add Security Key"
         ↓
┌─────────────────────────────────┐
│ WebAuthn Registration Flow      │
│ - Generate credential options    │
│ - Include user ID, challenge    │
│ - Exclude existing credentials  │
└────────┬────────────────────────┘
         │ 3. Send to browser
         ↓
┌─────────────────────────────────┐
│ Browser WebAuthn API            │
│ - User plugs in YubiKey         │
│ - User touches key              │
│ - Generate attestation          │
└────────┬────────────────────────┘
         │ 4. Send attestation to server
         ↓
┌─────────────────────────────────┐
│ Platform Server                 │
│ - Verify attestation            │
│ - Extract credential ID         │
│ - Store public key              │
│ - Link to user account          │
└────────┬────────────────────────┘
         │ 5. Success, show "Key Added"
         ↓
┌─────────────────────────────────┐
│ Platform Dashboard              │
│ - Show registered keys          │
└─────────────────────────────────┘

┌─────────────────┐
│ Enterprise User │
└────────┬────────┘
         │ 6. Login with security key
         ↓
┌─────────────────────────────────┐
│ Platform Login Page             │
│ - Show "Use Security Key" option│
└────────┬────────────────────────┘
         │ 7. Click "Use Security Key"
         ↓
┌─────────────────────────────────┐
│ WebAuthn Authentication Flow   │
│ - Generate authentication opts  │
│ - Include user ID, challenge    │
│ - Allow user's credential IDs   │
└────────┬────────────────────────┘
         │ 8. Send to browser
         ↓
┌─────────────────────────────────┐
│ Browser WebAuthn API            │
│ - User plugs in YubiKey         │
│ - User touches key              │
│ - Generate assertion            │
└────────┬────────────────────────┘
         │ 9. Send assertion to server
         ↓
┌─────────────────────────────────┐
│ Platform Server                 │
│ - Verify assertion              │
│ - Validate credential ID        │
│ - Create session                │
└────────┬────────────────────────┘
         │ 10. Session created
         ↓
┌─────────────────────────────────┐
│ Platform Dashboard              │
│ - User logged in                │
└─────────────────────────────────┘
```

### 5. Device Fingerprinting & Anomaly Detection Flow

```
┌─────────────────┐
│ Enterprise User │
└────────┬────────┘
         │ 1. Login attempt
         ↓
┌─────────────────────────────────┐
│ Platform Login Page             │
│ - Collect device info           │
│ - User-Agent, screen res, etc.  │
└────────┬────────────────────────┘
         │ 2. Submit credentials
         ↓
┌─────────────────────────────────┐
│ Authentication Service          │
│ - Validate credentials          │
│ - Generate device fingerprint   │
│ - Get IP geolocation            │
└────────┬────────────────────────┘
         │ 3. Check for anomalies
         ↓
┌─────────────────────────────────┐
│ Anomaly Detection Service       │
│ - Compare with known devices    │
│ - Check IP geolocation          │
│ - Check login time patterns     │
│ - Calculate risk score          │
└────────┬────────────────────────┘
         │ 4. Risk assessment
         ↓
         ├─ LOW RISK → Allow login
         │
         ├─ MEDIUM RISK → Require MFA
         │
         └─ HIGH RISK → Block and notify
         ↓
┌─────────────────────────────────┐
│ Case: MEDIUM RISK               │
│ - Show "Unusual login detected"  │
│ - Require additional MFA         │
│ - Send email notification       │
└────────┬────────────────────────┘
         │ 5. User completes MFA
         ↓
┌─────────────────────────────────┐
│ Authentication Service          │
│ - Allow login                   │
│ - Mark device as trusted        │
└────────┬────────────────────────┘
         │ 6. Session created
         ↓
┌─────────────────────────────────┐
│ Platform Dashboard              │
│ - User logged in                │
│ - Show "New device logged in"   │
└─────────────────────────────────┘
```

### 6. Password Policy Enforcement Flow

```
┌─────────────────┐
│ Enterprise User │
└────────┬────────┘
         │ 1. Navigate to Security Settings
         ↓
┌─────────────────────────────────┐
│ Platform Dashboard              │
│ - Show "Change Password"        │
│ - Display password policy       │
└────────┬────────────────────────┘
         │ 2. Enter new password
         ↓
┌─────────────────────────────────┐
│ Password Policy Validator       │
│ - Check minimum length (12+)    │
│ - Check complexity              │
│   (uppercase, lowercase, number, special)
│ - Check against password history │
│ - Check against common passwords│
│ - Check for personal info       │
│   (name, email, workspace name) │
└────────┬────────────────────────┘
         │ 3. Validation result
         ↓
         ├─ VALID → Allow change
         │
         └─ INVALID → Show specific errors
         ↓
┌─────────────────────────────────┐
│ Case: VALID                     │
│ - Hash password (argon2id)       │
│ - Update User record            │
│ - Add to password history       │
│ - Revoke all other sessions      │
│ - Send confirmation email       │
└────────┬────────────────────────┘
         │ 4. Success
         ↓
┌─────────────────────────────────┐
│ Platform Dashboard              │
│ - Show "Password changed"       │
└─────────────────────────────────┘
```

### 7. Comprehensive Login Audit Flow

```
┌─────────────────┐
│ Enterprise User │
└────────┬────────┘
         │ 1. Login attempt
         ↓
┌─────────────────────────────────┐
│ Authentication Service          │
│ - Validate credentials          │
│ - Collect login metadata        │
└────────┬────────────────────────┘
         │ 2. Log attempt
         ↓
┌─────────────────────────────────┐
│ Login Audit Service             │
│ - Record to LoginAudit table     │
│ Fields:                         │
│ - user_id                       │
│ - workspace_id                  │
│ - timestamp                     │
│ - success (true/false)          │
│ - failure_reason (if failed)    │
│ - ip_address                    │
│ - user_agent                    │
│ - device_fingerprint            │
│ - geolocation (country, city)   │
│ - login_method (password, SSO,  │
│   MFA, hardware key)            │
│ - risk_score                    │
│ - session_id (if success)       │
└────────┬────────────────────────┘
         │ 3. Real-time analysis
         ↓
┌─────────────────────────────────┐
│ Security Monitoring Service    │
│ - Check for brute force         │
│ - Check for concurrent logins   │
│ - Check for geo anomalies       │
│ - Trigger alerts if needed       │
└────────┬────────────────────────┘
         │ 4. Alert (if needed)
         ↓
┌─────────────────────────────────┐
│ Security Team / Workspace Owner │
│ - Receive alert                 │
│ - Review suspicious activity    │
└─────────────────────────────────┘
```

---

## Data Model Changes

### New Tables

#### 1. SsoProvider

```sql
CREATE TABLE sso_provider (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  provider_type VARCHAR(50) NOT NULL, -- 'saml', 'oidc'
  provider_name VARCHAR(100) NOT NULL, -- 'okta', 'azure-ad', 'onelogin'
  config JSONB NOT NULL, -- Provider-specific config
  -- For SAML:
  -- {
  --   sso_url: "https://...",
  --   slo_url: "https://...",
  --   certificate: "-----BEGIN CERTIFICATE-----...",
  --   entity_id: "https://...",
  --   name_id_format: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
  -- }
  -- For OIDC:
  -- {
  --   issuer: "https://...",
  --   authorization_endpoint: "https://...",
  --   token_endpoint: "https://...",
  --   jwks_uri: "https://...",
  --   client_id: "...",
  --   client_secret: "encrypted..."
  -- }
  email_domain_mapping JSONB DEFAULT '{}', -- {"@company.com": {"default_role": "editor", "default_workspace": "uuid"}}
  group_role_mapping JSONB DEFAULT '{}', -- {"Engineering": {"role": "editor"}, {"Executives": {"role": "admin"}}
  status VARCHAR(20) DEFAULT 'active', -- 'active', 'disabled'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  workspace_id, provider_type, provider_name UNIQUE
);

CREATE INDEX idx_sso_provider_workspace ON sso_provider(workspace_id);
CREATE INDEX idx_sso_provider_status ON sso_provider(status);
```

#### 2. SsoIdentity

```sql
CREATE TABLE sso_identity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  sso_provider_id UUID NOT NULL REFERENCES sso_provider(id) ON DELETE CASCADE,
  external_id VARCHAR(255) NOT NULL, -- SAML NameID or OIDC sub
  external_email VARCHAR(255),
  external_attributes JSONB DEFAULT '{}', -- Groups, name, etc.
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  user_id, sso_provider_id, external_id UNIQUE
);

CREATE INDEX idx_sso_identity_user ON sso_identity(user_id);
CREATE INDEX idx_sso_identity_provider ON sso_identity(sso_provider_id);
```

#### 3. ScimToken

```sql
CREATE TABLE scim_token (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  sso_provider_id UUID NOT NULL REFERENCES sso_provider(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(20) DEFAULT 'active', -- 'active', 'revoked'
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  workspace_id, sso_provider_id UNIQUE
);

CREATE INDEX idx_scim_token_workspace ON scim_token(workspace_id);
CREATE INDEX idx_scim_token_status ON scim_token(status);
```

#### 4. ScimEvent

```sql
CREATE TABLE scim_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  scim_token_id UUID REFERENCES scim_token(id) ON DELETE SET NULL,
  operation VARCHAR(10) NOT NULL, -- 'create', 'update', 'patch', 'delete'
  resource_type VARCHAR(50) NOT NULL, -- 'User', 'Group'
  resource_id VARCHAR(255),
  request_payload JSONB,
  response_status INTEGER,
  response_payload JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_scim_event_workspace ON scim_event(workspace_id);
CREATE INDEX idx_scim_event_token ON scim_event(scim_token_id);
CREATE INDEX idx_scim_event_created ON scim_event(created_at DESC);
```

#### 5. WebAuthnCredential

```sql
CREATE TABLE webauthn_credential (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  credential_id VARCHAR(255) NOT NULL UNIQUE,
  public_key TEXT NOT NULL, -- COSE key format
  counter BIGINT DEFAULT 0,
  device_type VARCHAR(50), -- 'single-device', 'multi-device'
  device_name VARCHAR(100),
  transports TEXT[], -- ['usb', 'nfc', 'ble', 'internal']
  backup_eligible BOOLEAN DEFAULT FALSE,
  backup_state BOOLEAN DEFAULT FALSE,
  attestation_type VARCHAR(50),
  aaguid UUID,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_webauthn_credential_user ON webauthn_credential(user_id);
```

#### 6. LoginAudit

```sql
CREATE TABLE login_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES user(id) ON DELETE SET NULL,
  workspace_id UUID REFERENCES workspace(id) ON DELETE SET NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  success BOOLEAN NOT NULL,
  failure_reason VARCHAR(100), -- 'invalid_credentials', 'mfa_required', 'blocked', etc.
  login_method VARCHAR(50) NOT NULL, -- 'password', 'sso_saml', 'sso_oidc', 'mfa_totp', 'mfa_webauthn'
  ip_address INET,
  user_agent TEXT,
  device_fingerprint VARCHAR(255),
  geolocation_country VARCHAR(2),
  geolocation_city VARCHAR(100),
  geolocation_lat DECIMAL(9,6),
  geolocation_lng DECIMAL(9,6),
  risk_score INTEGER DEFAULT 0, -- 0-100
  risk_factors JSONB DEFAULT '[]', -- ['new_device', 'new_location', 'unusual_time']
  session_id UUID REFERENCES session(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_login_audit_user ON login_audit(user_id);
CREATE INDEX idx_login_audit_workspace ON login_audit(workspace_id);
CREATE INDEX idx_login_audit_timestamp ON login_audit(timestamp DESC);
CREATE INDEX idx_login_audit_success ON login_audit(success);
CREATE INDEX idx_login_audit_ip ON login_audit(ip_address);
```

#### 7. PasswordHistory

```sql
CREATE TABLE password_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_password_history_user ON password_history(user_id);
CREATE INDEX idx_password_history_created ON password_history(created_at DESC);
```

#### 8. DeviceFingerprint

```sql
CREATE TABLE device_fingerprint (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  fingerprint_hash VARCHAR(255) NOT NULL,
  device_info JSONB, -- user_agent, screen_resolution, etc.
  is_trusted BOOLEAN DEFAULT FALSE,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  user_id, fingerprint_hash UNIQUE
);

CREATE INDEX idx_device_fingerprint_user ON device_fingerprint(user_id);
CREATE INDEX idx_device_fingerprint_hash ON device_fingerprint(fingerprint_hash);
```

### Changes to Existing Tables

#### User Table Additions

```sql
ALTER TABLE user ADD COLUMN sso_only BOOLEAN DEFAULT FALSE;
ALTER TABLE user ADD COLUMN last_login_at TIMESTAMPTZ;
ALTER TABLE user ADD COLUMN last_login_ip INET;
ALTER TABLE user ADD COLUMN failed_login_count INTEGER DEFAULT 0;
ALTER TABLE user ADD COLUMN locked_until TIMESTAMPTZ;
```

#### Workspace Table Additions

```sql
ALTER TABLE workspace ADD COLUMN sso_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE workspace ADD COLUMN sso_provider_id UUID REFERENCES sso_provider(id);
ALTER TABLE workspace ADD COLUMN password_policy JSONB DEFAULT '{}';
-- {
--   min_length: 12,
--   require_uppercase: true,
--   require_lowercase: true,
--   require_number: true,
--   require_special: true,
--   prevent_reuse: 5,
--   expiry_days: 90
-- }
```

---

## API Endpoints Needed

### SSO Configuration APIs

#### POST /api/workspaces/:workspaceId/sso/providers

Create SSO provider configuration

```json
{
  "provider_type": "saml" | "oidc",
  "provider_name": "okta",
  "config": { ... },
  "email_domain_mapping": { ... },
  "group_role_mapping": { ... }
}
```

#### GET /api/workspaces/:workspaceId/sso/providers

List SSO providers for workspace

#### PUT /api/workspaces/:workspaceId/sso/providers/:providerId

Update SSO provider configuration

#### DELETE /api/workspaces/:workspaceId/sso/providers/:providerId

Delete SSO provider

### SSO Login APIs

#### GET /api/auth/sso/:providerId/authorize

Initiate SSO login (redirect to IdP)

#### POST /api/auth/sso/:providerId/acs

Handle SAML Assertion Consumer Service

#### GET /api/auth/sso/:providerId/callback

Handle OIDC callback

### SCIM APIs

#### GET /api/scim/v2/Users

List users (SCIM 2.0)

#### POST /api/scim/v2/Users

Create user (SCIM 2.0)

#### GET /api/scim/v2/Users/:id

Get user (SCIM 2.0)

#### PUT /api/scim/v2/Users/:id

Replace user (SCIM 2.0)

#### PATCH /api/scim/v2/Users/:id

Update user (SCIM 2.0)

#### DELETE /api/scim/v2/Users/:id

Delete user (SCIM 2.0)

#### GET /api/scim/v2/ServiceProviderConfig

Get service provider config (SCIM 2.0)

### Hardware Key MFA APIs

#### POST /api/auth/webauthn/register/options

Get WebAuthn registration options

#### POST /api/auth/webauthn/register/verify

Verify WebAuthn registration

#### POST /api/auth/webauthn/authenticate/options

Get WebAuthn authentication options

#### POST /api/auth/webauthn/authenticate/verify

Verify WebAuthn authentication

#### GET /api/users/:userId/webauthn/credentials

List user's WebAuthn credentials

#### DELETE /api/users/:userId/webauthn/credentials/:credentialId

Delete WebAuthn credential

### Login Audit APIs

#### GET /api/workspaces/:workspaceId/login-audit

Get login audit log for workspace

```
Query params:
- start_date
- end_date
- user_id
- success (true/false)
- login_method
- ip_address
```

#### GET /api/users/:userId/login-audit

Get login audit log for specific user

### Password Policy APIs

#### GET /api/workspaces/:workspaceId/password-policy

Get workspace password policy

#### PUT /api/workspaces/:workspaceId/password-policy

Update workspace password policy

---

## Implementation Priority

### Phase 1-2 (Critical - v1.1)

1. **FR-AUTH-09:** SAML 2.0 / OIDC SSO Integration
2. **FR-AUTH-12:** Device Fingerprinting & Geographic Anomaly Detection
3. **FR-AUTH-14:** Comprehensive Login Audit

### Phase 3-4 (High - v1.2)

4. **FR-AUTH-11:** Hardware Key MFA (WebAuthn/FIDO2)
5. **FR-AUTH-13:** Enforceable Password Policies

### Phase 5-6 (Medium - v2.0)

6. **FR-AUTH-10:** SCIM 2.0 Provisioning

---

## Dependencies

### Must Exist First

- Workspace Management (Module 2) - for SSO workspace mapping
- RBAC System - for group-to-role mapping
- Audit Log (Module 16) - for login audit integration

### Can Be Implemented In Parallel

- Hardware Key MFA (independent of SSO)
- Password Policies (independent of SSO)
- Device Fingerprinting (independent of SSO)

### Must Come After

- SCIM Provisioning (requires SSO integration first)

---

## Testing Requirements

### Unit Tests

- SAML response validation
- OIDC token validation
- WebAuthn credential registration/verification
- Device fingerprint generation
- Password policy validation
- Risk score calculation

### Integration Tests

- End-to-end SSO login flow with test IdP
- SCIM provisioning with test IdP
- WebAuthn registration/authentication flow
- Anomaly detection with simulated attacks
- Password policy enforcement

### Security Tests

- SAML signature spoofing attempts
- OIDC token manipulation
- WebAuthn credential theft attempts
- Brute force protection
- Session hijacking attempts

### Performance Tests

- SSO login latency under load
- SCIM bulk provisioning performance
- Login audit query performance
- Device fingerprint calculation speed

---

## Security Considerations

### SSO Security

- **SAML:** Validate all signatures, check for replay attacks, enforce strict clock skew
- **OIDC:** Validate all tokens, check nonce, verify issuer, validate audience
- **Certificate Management:** Regular certificate rotation, monitor expiry
- **State Parameter:** Use secure random state to prevent CSRF

### SCIM Security

- **Bearer Token:** Use strong random tokens, implement token rotation
- **Rate Limiting:** Strict rate limits on SCIM endpoints
- **Authorization:** Verify workspace access on every request
- **Audit:** Log all SCIM operations for compliance

### WebAuthn Security

- **Origin Validation:** Verify origin during authentication
- **Challenge Verification:** Ensure challenge is used only once
- **Counter Check:** Verify counter to prevent replay attacks
- **Backup Eligibility:** Respect user's backup preferences

### Device Fingerprinting

- **Privacy:** Don't store PII in fingerprints, hash all data
- **Consent:** Inform users about device tracking
- **Data Retention:** Limit retention of device data

### Login Audit

- **PII:** Hash IP addresses where possible, limit geolocation precision
- **Retention:** Define retention policy for audit logs
- **Access Control:** Strict RBAC on audit log access

---

## Migration Strategy

### Phase 1: SSO Integration

1. Add SSO provider tables
2. Implement SAML 2.0 library integration
3. Implement OIDC library integration
4. Create SSO configuration UI
5. Implement SSO login flow
6. Test with test IdP (Okta/Azure AD)

### Phase 2: Device Fingerprinting

1. Add device fingerprint table
2. Implement fingerprint generation library
3. Integrate with login flow
4. Implement anomaly detection rules
5. Add login audit table
6. Create audit UI

### Phase 3: Hardware Key MFA

1. Add WebAuthn credential table
2. Implement WebAuthn library integration
3. Create registration UI
4. Integrate with login flow
5. Test with hardware keys

### Phase 4: Password Policies

1. Add password history table
2. Implement policy validation
3. Create policy configuration UI
4. Enforce policies on password change
5. Implement password expiry

### Phase 5: SCIM Provisioning

1. Add SCIM token and event tables
2. Implement SCIM 2.0 endpoints
3. Implement provisioning logic
4. Create SCIM configuration UI
5. Test with test IdP

---

## Monitoring & Observability

### Metrics to Track

- SSO login success/failure rate
- SSO login latency (p50, p95, p99)
- SCIM provisioning success/failure rate
- WebAuthn registration/authentication rate
- Failed login attempts per user
- Anomaly detection triggers
- Password policy violations

### Alerts to Configure

- High SSO failure rate (> 5%)
- SCIM provisioning failures
- Brute force attack detected
- Unusual login pattern detected
- SSO certificate expiry warning

---

## Documentation Requirements

### User Documentation

- How to configure SSO (step-by-step for Okta, Azure AD, OneLogin)
- How to configure SCIM provisioning
- How to register hardware keys
- How to set password policies
- How to review login audit logs

### Developer Documentation

- SSO integration guide
- SCIM API documentation
- WebAuthn integration guide
- Login audit API documentation
- Security best practices

### Admin Documentation

- SSO troubleshooting guide
- SCIM troubleshooting guide
- Security incident response procedures
- Audit log review procedures

---

## Rollback Plan

If issues arise:

1. Disable SSO for affected workspaces
2. Revoke SCIM tokens
3. Fall back to password authentication
4. Monitor login audit for anomalies
5. Notify affected users

---

## Success Criteria

- ✅ SSO login works with at least 2 major IdPs (Okta, Azure AD)
- ✅ SCIM provisioning successfully syncs users
- ✅ Hardware key MFA works with YubiKey
- ✅ Device fingerprinting detects new devices
- ✅ Anomaly detection blocks suspicious logins
- ✅ Password policies are enforced
- ✅ Login audit captures all attempts
- ✅ Performance targets met (SSO login < 3s)
- ✅ Security tests pass
- ✅ Documentation is complete

---

**Next Module:** [02-workspace-management.md](02-workspace-management.md)
