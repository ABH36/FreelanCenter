# Module 2: Workspace Management Enhancements

**Status:** High Priority (Phase 1-2)  
**Current SRS Coverage:** FR-WS-01 to FR-WS-05  
**Missing Features:** FR-WS-06 to FR-WS-12

---

## Current State

### What Exists Today (FR-WS-01 to FR-WS-05)

- ✅ Workspace creation with unique slug
- ✅ Workspace settings, members, roles
- ✅ Platform subdomain namespace per workspace
- ✅ Workspace suspension by Platform Admin
- ✅ Data export and deletion with grace period

### Current Flow

```
User → Create Workspace → Set Name/Slug → Invite Members →
Configure Settings → Add Projects → Manage Resources
```

---

## Missing Enterprise Features

### FR-WS-06: Workspace Hierarchy

**Priority:** SHOULD (Phase 3)  
**Use Case:** Multi-location agencies (e.g., a restaurant chain with locations in multiple cities) need parent-child workspace relationships for centralized management.

### FR-WS-07: Granular Resource Quotas

**Priority:** MUST (Phase 1)  
**Use Case:** Enterprise clients need fine-grained control over resource usage per workspace (projects, domains, AI credits, storage).

### FR-WS-08: Budget Controls

**Priority:** SHOULD (Phase 4)  
**Use Case:** Enterprises need spend limits, alerts, and approval workflows to control costs.

### FR-WS-09: Workspace Analytics Dashboard

**Priority:** MUST (Phase 1)  
**Use Case:** Workspace owners need visibility into usage, costs, trends, and projections.

### FR-WS-10: Workspace Backup and Restore

**Priority:** COULD (Phase 5)  
**Use Case:** Critical workspaces need backup and restore capabilities for disaster recovery.

### FR-WS-11: Custom Role Definitions

**Priority:** SHOULD (Phase 3)  
**Use Case:** Enterprise clients need custom roles with fine-grained permissions beyond the fixed roles.

### FR-WS-12: Workspace Merger and Acquisition

**Priority:** COULD (Phase 6)  
**Use Case:** When agencies merge or acquire others, they need to merge workspaces.

---

## Module Connections

### Upstream Dependencies

- **Authentication (Module 1):** SSO users need workspace mapping
- **Billing (Module 11):** Quotas and budgets need billing integration
- **RBAC System:** Custom roles need permission system

### Downstream Dependencies

- **Project Management (Module 3):** Workspace hierarchy affects project organization
- **Analytics (Module 22):** Workspace analytics feed into observability
- **Backup/DR:** Workspace backup affects disaster recovery strategy

---

## Detailed Flow Diagrams

### 1. Workspace Hierarchy Flow

```
┌─────────────────────────────────┐
│ Agency Owner (Parent Workspace) │
└────────┬────────────────────────┘
         │ 1. Create Child Workspace
         ↓
┌─────────────────────────────────┐
│ Workspace Hierarchy UI          │
│ - Show "Create Child Workspace"  │
│ - Inherit settings option        │
│ - Copy members option            │
└────────┬────────────────────────┘
         │ 2. Configure child workspace
         ↓
┌─────────────────────────────────┐
│ Workspace Creation Service      │
│ - Validate parent workspace      │
│ - Create child workspace         │
│ - Link to parent                 │
│ - Inherit quotas (if enabled)   │
│ - Copy members (if enabled)      │
└────────┬────────────────────────┘
         │ 3. Child workspace created
         ↓
┌─────────────────────────────────┐
│ Parent Workspace Dashboard      │
│ - Show child workspaces           │
│ - View aggregated metrics        │
│ - Manage inherited settings      │
└────────┬────────────────────────┘
         │ 4. Navigate to child
         ↓
┌─────────────────────────────────┐
│ Child Workspace Dashboard       │
│ - Shows "Child of X" badge       │
│ - Can override inherited settings│
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ Resource Access Flow            │
└────────┬────────────────────────┘
         │ 1. User requests resource
         ↓
┌─────────────────────────────────┐
│ Authorization Service          │
│ - Check user's workspace        │
│ - Check if child workspace      │
│ - Check parent workspace access  │
│ - Resolve effective permissions  │
└────────┬────────────────────────┘
         │ 2. Permission resolved
         ↓
         ├─ Has access → Allow
         │
         └─ No access → Deny
```

### 2. Granular Resource Quotas Flow

```
┌─────────────────────────────────┐
│ Workspace Owner                 │
└────────┬────────────────────────┘
         │ 1. Navigate to Workspace Settings
         ↓
┌─────────────────────────────────┐
│ Quota Configuration UI          │
│ - Show current usage vs limits   │
│ - Resource types:               │
│   - Projects (max count)         │
│   - Domains (max count)         │
│   - AI Credits (monthly)         │
│   - Storage (GB)                │
│   - Team members (max count)     │
│   - Templates (max installed)    │
└────────┬────────────────────────┘
         │ 2. Update quota limits
         ↓
┌─────────────────────────────────┐
│ Quota Service                   │
│ - Validate against plan limits   │
│ - Update ResourceQuota table     │
│ - Log quota change               │
└────────┬────────────────────────┘
         │ 3. Quota updated
         ↓
┌─────────────────────────────────┐
│ Quota Enforcement Flow          │
└────────┬────────────────────────┘
         │ 1. User attempts action
         ↓
┌─────────────────────────────────┐
│ Quota Check Service             │
│ - Get current usage              │
│ - Get quota limit                │
│ - Check if action would exceed   │
└────────┬────────────────────────┘
         │ 2. Quota check result
         ↓
         ├─ Within quota → Allow action
         │
         └─ Would exceed → Block and notify
         ↓
┌─────────────────────────────────┐
│ User Notification               │
│ - Show "Quota exceeded" error    │
│ - Link to upgrade plan          │
│ - Show current usage             │
└─────────────────────────────────┘
```

### 3. Budget Controls Flow

```
┌─────────────────────────────────┐
│ Workspace Owner                 │
└────────┬────────────────────────┘
         │ 1. Navigate to Budget Settings
         ↓
┌─────────────────────────────────┐
│ Budget Configuration UI         │
│ - Set monthly spend limit       │
│ - Set per-resource limits       │
│ - Configure alert thresholds     │
│ - Set approval workflow          │
└────────┬────────────────────────┘
         │ 2. Configure budget
         ↓
┌─────────────────────────────────┐
│ Budget Service                  │
│ - Create BudgetLimit record      │
│ - Create BudgetAlert rules      │
│ - Link to approval workflow     │
└────────┬────────────────────────┘
         │ 3. Budget configured
         ↓
┌─────────────────────────────────┐
│ Budget Monitoring Flow          │
└────────┬────────────────────────┘
         │ 1. Resource consumed
         ↓
┌─────────────────────────────────┐
│ Usage Tracking Service          │
│ - Record usage event             │
│ - Update current spend           │
│ - Check against budget limits   │
└────────┬────────────────────────┘
         │ 2. Budget check
         ↓
         ├─ Within limit → Allow
         │
         ├─ Approaching limit → Send alert
         │
         └─ Exceeded limit → Block or alert
         ↓
┌─────────────────────────────────┐
│ Case: Alert Threshold Reached   │
│ - Send email to owner           │
│ - Send Slack notification        │
│ - Show in-dashboard warning     │
└────────┬────────────────────────┘
         │ 3. Owner takes action
         ↓
┌─────────────────────────────────┐
│ Owner Options                   │
│ - Increase budget limit          │
│ - Reduce usage                  │
│ - Upgrade plan                  │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ Approval Workflow Flow          │
└────────┬────────────────────────┘
         │ 1. Action would exceed budget
         ↓
┌─────────────────────────────────┐
│ Budget Service                  │
│ - Check if approval required     │
│ - Create BudgetApproval request  │
└────────┬────────────────────────┘
         │ 2. Request approval
         ↓
┌─────────────────────────────────┐
│ Approver (Owner/Admin)          │
│ - Review request                │
│ - Approve or deny               │
└────────┬────────────────────────┘
         │ 3. Decision
         ↓
         ├─ Approved → Execute action
         │
         └─ Denied → Notify requester
```

### 4. Workspace Analytics Dashboard Flow

```
┌─────────────────────────────────┐
│ Workspace Owner                 │
└────────┬────────────────────────┘
         │ 1. Navigate to Analytics
         ↓
┌─────────────────────────────────┐
│ Analytics Dashboard             │
│ Tabs:                           │
│ - Overview                      │
│ - Usage                         │
│ - Costs                         │
│ - Trends                        │
│ - Projections                   │
└────────┬────────────────────────┘
         │ 2. Select Overview tab
         ↓
┌─────────────────────────────────┐
│ Overview Metrics                │
│ - Total projects                │
│ - Active projects               │
│ - Total domains                 │
│ - Active domains                │
│ - Total team members             │
│ - AI credits used this month    │
│ - Storage used                  │
│ - Monthly cost                  │
│ - Project success rate          │
│ - Lead conversion rate          │
└────────┬────────────────────────┘
         │ 3. Select Usage tab
         ↓
┌─────────────────────────────────┐
│ Usage Breakdown                 │
│ - Projects by status            │
│ - Domains by type               │
│ - AI credits by feature         │
│ - Storage by project            │
│ - Team member activity          │
│ - Template usage                │
└────────┬────────────────────────┘
         │ 4. Select Costs tab
         ↓
┌─────────────────────────────────┐
│ Cost Breakdown                  │
│ - Hosting costs                 │
│ - AI costs                      │
│ - Storage costs                 │
│ - Domain costs                  │
│ - Email/SMS costs               │
│ - Third-party integration costs │
│ - Total cost by month           │
└────────┬────────────────────────┘
         │ 5. Select Trends tab
         ↓
┌─────────────────────────────────┐
│ Trend Analysis                  │
│ - Project creation trend        │
│ - Lead generation trend         │
│ - AI usage trend                │
│ - Cost trend                    │
│ - Team member trend             │
│ - Domain addition trend         │
└────────┬────────────────────────┘
         │ 6. Select Projections tab
         ↓
┌─────────────────────────────────┐
│ Future Projections              │
│ - Projected cost next month     │
│ - Projected AI credit usage    │
│ - Projected storage growth      │
│ - Recommendations               │
└─────────────────────────────────┘
```

### 5. Workspace Backup and Restore Flow

```
┌─────────────────────────────────┐
│ Workspace Owner / Admin         │
└────────┬────────────────────────┘
         │ 1. Navigate to Backup Settings
         ↓
┌─────────────────────────────────┐
│ Backup Configuration UI         │
│ - Show backup schedule          │
│ - Show retention policy         │
│ - Show backup history           │
│ - "Create Manual Backup" button │
└────────┬────────────────────────┘
         │ 2. Create manual backup
         ↓
┌─────────────────────────────────┐
│ Backup Service                 │
│ - Validate permissions           │
│ - Create snapshot of workspace  │
│ - Include:                     │
│   - All projects                │
│   - SiteDrafts and SiteVersions │
│   - Assets                      │
│   - Leads                       │
│   - Memberships                 │
│   - Settings                    │
│ - Store in encrypted backup     │
│ - Log backup job                │
└────────┬────────────────────────┘
         │ 3. Backup in progress
         ↓
┌─────────────────────────────────┐
│ Backup Progress                 │
│ - Show progress bar              │
│ - Show current step              │
│ - Estimated time remaining      │
└────────┬────────────────────────┘
         │ 4. Backup complete
         ↓
┌─────────────────────────────────┐
│ Backup Complete                 │
│ - Show backup summary           │
│ - Show backup size              │
│ - Show backup ID                │
└────────┬────────────────────────┘

┌─────────────────────────────────┐
│ Restore Flow                    │
└────────┬────────────────────────┘
         │ 1. Select backup to restore
         ↓
┌─────────────────────────────────┐
│ Restore Confirmation UI        │
│ - Show backup details           │
│ - Warning: will overwrite       │
│ - "Confirm Restore" button       │
└────────┬────────────────────────┘
         │ 2. Confirm restore
         ↓
┌─────────────────────────────────┐
│ Restore Service                │
│ - Validate permissions           │
│ - Create restore job             │
│ - Decrypt backup                │
│ - Restore projects              │
│ - Restore SiteDrafts/Versions   │
│ - Restore assets                │
│ - Restore leads                 │
│ - Restore memberships           │
│ - Restore settings              │
│ - Log restore job               │
└────────┬────────────────────────┘
         │ 3. Restore in progress
         ↓
┌─────────────────────────────────┐
│ Restore Progress               │
│ - Show progress bar              │
│ - Show current step              │
│ - Show items restored           │
└────────┬────────────────────────┘
         │ 4. Restore complete
         ↓
┌─────────────────────────────────┐
│ Restore Complete                │
│ - Show restore summary           │
│ - Show any errors               │
│ - Option to review restored data│
└─────────────────────────────────┘
```

### 6. Custom Role Definitions Flow

```
┌─────────────────────────────────┐
│ Workspace Owner                 │
└────────┬────────────────────────┘
         │ 1. Navigate to Roles Settings
         ↓
┌─────────────────────────────────┐
│ Roles Management UI             │
│ - Show built-in roles           │
│ - Show custom roles             │
│ - "Create Custom Role" button   │
└────────┬────────────────────────┘
         │ 2. Create custom role
         ↓
┌─────────────────────────────────┐
│ Role Creator UI                 │
│ - Role name                     │
│ - Role description              │
│ - Permissions:                 │
│   - Projects (CRUD)             │
│   - Sites (publish, staging)    │
│   - Leads (view, edit, delete)  │
│   - Domains (manage)            │
│   - Members (invite, remove)    │
│   - Billing (view)              │
│   - Analytics (view)            │
│   - AI (use)                   │
│   - Templates (install)         │
└────────┬────────────────────────┘
         │ 3. Configure permissions
         ↓
┌─────────────────────────────────┐
│ Role Service                   │
│ - Validate role name            │
│ - Create CustomRole record      │
│ - Create RolePermission records │
│ - Link to workspace             │
└────────┬────────────────────────┘
         │ 4. Role created
         ↓
┌─────────────────────────────────┐
│ Role Assignment Flow            │
└────────┬────────────────────────┘
         │ 1. Assign role to member
         ↓
┌─────────────────────────────────┐
│ Membership Service             │
│ - Update member role             │
│ - Resolve effective permissions  │
│ - Cache permissions              │
└────────┬────────────────────────┘
         │ 2. Role assigned
         ↓
┌─────────────────────────────────┐
│ Authorization Check Flow      │
└────────┬────────────────────────┘
         │ 1. User attempts action
         ↓
┌─────────────────────────────────┐
│ Authorization Service          │
│ - Get user's role               │
│ - Get role permissions          │
│ - Check if action allowed       │
└────────┬────────────────────────┘
         │ 3. Permission check
         ↓
         ├─ Allowed → Execute action
         │
         └─ Denied → Show error
```

### 7. Workspace Merger Flow

```
┌─────────────────────────────────┐
│ Platform Admin                 │
└────────┬────────────────────────┘
         │ 1. Navigate to Workspace Management
         ↓
┌─────────────────────────────────┐
│ Workspace Merger UI            │
│ - Select source workspace(s)   │
│ - Select target workspace      │
│ - Merger options:              │
│   - Merge projects              │
│   - Merge members               │
│   - Merge domains               │
│   - Merge assets                │
│   - Merge leads                 │
│   - Preserve source data        │
└────────┬────────────────────────┘
         │ 2. Configure merger
         ↓
┌─────────────────────────────────┐
│ Merger Service                 │
│ - Validate permissions           │
│ - Create WorkspaceMerger job    │
│ - Pre-merger validation         │
│ - Check for conflicts          │
└────────┬────────────────────────┘
         │ 3. Validation result
         ↓
         ├─ No conflicts → Proceed
         │
         └─ Conflicts found → Show to admin
         ↓
┌─────────────────────────────────┐
│ Conflict Resolution UI          │
│ - Show conflicts                │
│ - Resolution options:           │
│   - Keep target                 │
│   - Keep source                 │
│   - Merge both                  │
│   - Skip                        │
└────────┬────────────────────────┘
         │ 4. Resolve conflicts
         ↓
┌─────────────────────────────────┐
│ Merger Execution               │
│ - Create backup of both workspaces│
│ - Merge projects to target       │
│ - Merge members to target        │
│ - Merge domains to target        │
│ - Merge assets to target         │
│ - Merge leads to target          │
│ - Update references              │
│ - Soft-delete source workspaces  │
│ - Log merger job                 │
└────────┬────────────────────────┘
         │ 5. Merger in progress
         ↓
┌─────────────────────────────────┐
│ Merger Progress                 │
│ - Show progress bar              │
│ - Show current step              │
│ - Show items merged             │
└────────┬────────────────────────┘
         │ 6. Merger complete
         ↓
┌─────────────────────────────────┐
│ Merger Complete                 │
│ - Show merger summary           │
│ - Show any errors               │
│ - Show backup IDs                │
│ - Option to review merged data   │
└─────────────────────────────────┘
```

---

## Data Model Changes

### New Tables

#### 1. WorkspaceRelation

```sql
CREATE TABLE workspace_relation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  child_workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  relation_type VARCHAR(20) DEFAULT 'child', -- 'child', 'franchise', 'location'
  inherit_settings BOOLEAN DEFAULT TRUE,
  inherit_quotas BOOLEAN DEFAULT TRUE,
  inherit_members BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  parent_workspace_id, child_workspace_id UNIQUE
);

CREATE INDEX idx_workspace_relation_parent ON workspace_relation(parent_workspace_id);
CREATE INDEX idx_workspace_relation_child ON workspace_relation(child_workspace_id);
```

#### 2. ResourceQuota

```sql
CREATE TABLE resource_quota (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  resource_type VARCHAR(50) NOT NULL, -- 'projects', 'domains', 'ai_credits', 'storage', 'members', 'templates'
  quota_limit INTEGER NOT NULL,
  quota_used INTEGER DEFAULT 0,
  quota_period VARCHAR(20) DEFAULT 'monthly', -- 'monthly', 'yearly', 'one_time'
  alert_threshold_percent INTEGER DEFAULT 80,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  workspace_id, resource_type UNIQUE
);

CREATE INDEX idx_resource_quota_workspace ON resource_quota(workspace_id);
CREATE INDEX idx_resource_quota_type ON resource_quota(resource_type);
```

#### 3. ResourceUsage

```sql
CREATE TABLE resource_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID, -- Reference to the specific resource
  usage_amount INTEGER NOT NULL,
  usage_unit VARCHAR(20), -- 'count', 'credits', 'bytes', 'gb'
  cost_cents INTEGER DEFAULT 0,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_resource_usage_workspace ON resource_usage(workspace_id);
CREATE INDEX idx_resource_usage_type ON resource_usage(resource_type);
CREATE INDEX idx_resource_usage_period ON resource_usage(period_start, period_end);
```

#### 4. BudgetLimit

```sql
CREATE TABLE budget_limit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  budget_type VARCHAR(50) NOT NULL, -- 'monthly', 'yearly', 'per_project'
  limit_cents INTEGER NOT NULL,
  current_spend_cents INTEGER DEFAULT 0,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  approval_required BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  workspace_id, budget_type, period_start UNIQUE
);

CREATE INDEX idx_budget_limit_workspace ON budget_limit(workspace_id);
CREATE INDEX idx_budget_limit_period ON budget_limit(period_start, period_end);
```

#### 5. BudgetAlert

```sql
CREATE TABLE budget_alert (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_limit_id UUID NOT NULL REFERENCES budget_limit(id) ON DELETE CASCADE,
  alert_threshold_percent INTEGER NOT NULL,
  alert_channels JSONB DEFAULT '["email"]', -- ['email', 'slack', 'sms']
  is_triggered BOOLEAN DEFAULT FALSE,
  triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_budget_alert_budget ON budget_alert(budget_limit_id);
```

#### 6. BudgetApproval

```sql
CREATE TABLE budget_approval (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  requester_id UUID NOT NULL REFERENCES user(id),
  approver_id UUID REFERENCES user(id),
  action_type VARCHAR(50) NOT NULL, -- 'create_project', 'add_domain', 'ai_usage'
  estimated_cost_cents INTEGER,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'denied'
  request_reason TEXT,
  approval_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX idx_budget_approval_workspace ON budget_approval(workspace_id);
CREATE INDEX idx_budget_approval_status ON budget_approval(status);
CREATE INDEX idx_budget_approval_requester ON budget_approval(requester_id);
```

#### 7. CustomRole

```sql
CREATE TABLE custom_role (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_system_role BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  workspace_id, name UNIQUE
);

CREATE INDEX idx_custom_role_workspace ON custom_role(workspace_id);
```

#### 8. RolePermission

```sql
CREATE TABLE role_permission (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id UUID NOT NULL REFERENCES custom_role(id) ON DELETE CASCADE,
  permission VARCHAR(100) NOT NULL, -- 'projects.create', 'sites.publish', 'leads.view', etc.
  granted BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_role_permission_role ON role_permission(role_id);
CREATE INDEX idx_role_permission_permission ON role_permission(permission);
```

#### 9. BackupJob

```sql
CREATE TABLE backup_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  backup_type VARCHAR(20) NOT NULL, -- 'manual', 'scheduled'
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'in_progress', 'completed', 'failed'
  backup_size_bytes BIGINT,
  backup_location VARCHAR(255), -- R2 path, S3 path, etc.
  encryption_key_id VARCHAR(255),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_by UUID REFERENCES user(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_backup_job_workspace ON backup_job(workspace_id);
CREATE INDEX idx_backup_job_status ON backup_job(status);
CREATE INDEX idx_backup_job_created ON backup_job(created_at DESC);
```

#### 10. RestoreJob

```sql
CREATE TABLE restore_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  backup_job_id UUID NOT NULL REFERENCES backup_job(id),
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'in_progress', 'completed', 'failed'
  restore_options JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_by UUID REFERENCES user(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_restore_job_workspace ON restore_job(workspace_id);
CREATE INDEX idx_restore_job_backup ON restore_job(backup_job_id);
CREATE INDEX idx_restore_job_status ON restore_job(status);
```

#### 11. WorkspaceMerger

```sql
CREATE TABLE workspace_merger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_workspace_ids UUID[] NOT NULL,
  target_workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'validating', 'in_progress', 'completed', 'failed'
  merger_options JSONB,
  conflicts JSONB DEFAULT '[]',
  backup_ids UUID[],
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_by UUID REFERENCES user(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workspace_merger_target ON workspace_merger(target_workspace_id);
CREATE INDEX idx_workspace_merger_status ON workspace_merger(status);
```

### Changes to Existing Tables

#### Workspace Table Additions

```sql
ALTER TABLE workspace ADD COLUMN parent_workspace_id UUID REFERENCES workspace(id);
ALTER TABLE workspace ADD COLUMN quota_override JSONB DEFAULT '{}';
ALTER TABLE workspace ADD COLUMN budget_limit_id UUID REFERENCES budget_limit(id);
ALTER TABLE workspace ADD COLUMN backup_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE workspace ADD COLUMN backup_schedule VARCHAR(50) DEFAULT 'daily';
ALTER TABLE workspace ADD COLUMN backup_retention_days INTEGER DEFAULT 30;
```

#### Membership Table Additions

```sql
ALTER TABLE membership ADD COLUMN custom_role_id UUID REFERENCES custom_role(id);
```

---

## API Endpoints Needed

### Workspace Hierarchy APIs

#### POST /api/workspaces/:workspaceId/children

Create child workspace

#### GET /api/workspaces/:workspaceId/children

List child workspaces

#### GET /api/workspaces/:workspaceId/parent

Get parent workspace

#### PUT /api/workspaces/:workspaceId/hierarchy-settings

Update hierarchy settings (inherit flags)

### Resource Quota APIs

#### GET /api/workspaces/:workspaceId/quotas

Get all resource quotas for workspace

#### PUT /api/workspaces/:workspaceId/quotas/:resourceType

Update quota for specific resource

#### GET /api/workspaces/:workspaceId/usage

Get current resource usage

#### GET /api/workspaces/:workspaceId/usage/:resourceType

Get usage for specific resource

### Budget Control APIs

#### GET /api/workspaces/:workspaceId/budget

Get budget limits

#### PUT /api/workspaces/:workspaceId/budget

Set budget limits

#### GET /api/workspaces/:workspaceId/budget/approvals

List budget approval requests

#### POST /api/workspaces/:workspaceId/budget/approvals

Create budget approval request

#### PUT /api/workspaces/:workspaceId/budget/approvals/:approvalId

Approve/deny budget request

### Analytics APIs

#### GET /api/workspaces/:workspaceId/analytics/overview

Get overview metrics

#### GET /api/workspaces/:workspaceId/analytics/usage

Get usage breakdown

#### GET /api/workspaces/:workspaceId/analytics/costs

Get cost breakdown

#### GET /api/workspaces/:workspaceId/analytics/trends

Get trend analysis

#### GET /api/workspaces/:workspaceId/analytics/projections

Get future projections

### Backup/Restore APIs

#### POST /api/workspaces/:workspaceId/backups

Create manual backup

#### GET /api/workspaces/:workspaceId/backups

List backup jobs

#### GET /api/workspaces/:workspaceId/backups/:backupId

Get backup job details

#### POST /api/workspaces/:workspaceId/restore

Restore from backup

#### GET /api/workspaces/:workspaceId/restore-jobs

List restore jobs

#### GET /api/workspaces/:workspaceId/restore-jobs/:restoreId

Get restore job details

### Custom Role APIs

#### GET /api/workspaces/:workspaceId/roles

List all roles (built-in + custom)

#### POST /api/workspaces/:workspaceId/roles

Create custom role

#### PUT /api/workspaces/:workspaceId/roles/:roleId

Update custom role

#### DELETE /api/workspaces/:workspaceId/roles/:roleId

Delete custom role

#### GET /api/workspaces/:workspaceId/roles/:roleId/permissions

Get role permissions

#### PUT /api/workspaces/:workspaceId/roles/:roleId/permissions

Update role permissions

### Workspace Merger APIs

#### POST /api/workspaces/merge

Initiate workspace merger

#### GET /api/workspace-mergers/:mergerId

Get merger job details

#### POST /api/workspace-mergers/:mergerId/resolve-conflicts

Resolve merger conflicts

#### POST /api/workspace-mergers/:mergerId/execute

Execute merger after conflict resolution

---

## Implementation Priority

### Phase 1-2 (Critical - v1.1)

1. **FR-WS-07:** Granular Resource Quotas
2. **FR-WS-09:** Workspace Analytics Dashboard

### Phase 3-4 (High - v1.2)

3. **FR-WS-06:** Workspace Hierarchy
4. **FR-WS-11:** Custom Role Definitions

### Phase 5-6 (Medium - v2.0)

5. **FR-WS-08:** Budget Controls
6. **FR-WS-10:** Workspace Backup and Restore

### Phase 7-8+ (Low - v2.1+)

7. **FR-WS-12:** Workspace Merger and Acquisition

---

## Dependencies

### Must Exist First

- Authentication (Module 1) - for workspace access control
- Billing (Module 11) - for quota and budget integration
- RBAC System - for custom role permissions

### Can Be Implemented In Parallel

- Resource Quotas (independent of hierarchy)
- Analytics Dashboard (independent of other features)
- Custom Roles (independent of hierarchy)

### Must Come After

- Workspace Hierarchy (after RBAC is stable)
- Budget Controls (after quotas are implemented)
- Backup/Restore (after all data models are stable)

---

## Testing Requirements

### Unit Tests

- Quota validation logic
- Budget limit checking
- Permission resolution for custom roles
- Backup job creation
- Restore job validation
- Workspace hierarchy resolution

### Integration Tests

- End-to-end quota enforcement
- Budget approval workflow
- Analytics data aggregation
- Backup and restore flow
- Workspace merger with conflicts

### Performance Tests

- Analytics query performance with large datasets
- Backup job performance with large workspaces
- Restore job performance
- Quota check performance under load

### Security Tests

- Quota bypass attempts
- Budget limit manipulation
- Role privilege escalation
- Backup data access control
- Restore authorization

---

## Security Considerations

### Resource Quotas

- **Server-Side Enforcement:** Always enforce quotas server-side, never trust client
- **Race Conditions:** Use database constraints to prevent quota overruns
- **Audit Logging:** Log all quota changes and violations

### Budget Controls

- **Approval Security:** Validate approver permissions
- **Audit Trail:** Log all budget changes and approvals
- **Alert Security:** Ensure alerts don't leak sensitive data

### Workspace Hierarchy

- **Access Control:** Ensure parent workspace access doesn't automatically grant child access
- **Permission Resolution:** Clear rules for permission inheritance
- **Audit Logging:** Log all hierarchy changes

### Custom Roles

- **Permission Validation:** Validate all permissions against a safe list
- **Role Assignment:** Ensure only owners can create/assign custom roles
- **Audit Logging:** Log all role changes and assignments

### Backup/Restore

- **Encryption:** All backups must be encrypted at rest
- **Access Control:** Strict RBAC on backup/restore operations
- **Audit Logging:** Log all backup and restore operations

### Workspace Merger

- **Authorization:** Only platform admins can initiate mergers
- **Validation:** Comprehensive pre-merger validation
- **Backup:** Always create backups before merging
- **Audit Logging:** Detailed audit trail of all merger operations

---

## Migration Strategy

### Phase 1: Resource Quotas

1. Add ResourceQuota and ResourceUsage tables
2. Implement quota checking service
3. Integrate with project creation, domain addition, etc.
4. Create quota configuration UI
5. Migrate existing workspaces to default quotas

### Phase 2: Analytics Dashboard

1. Add ResourceUsage tracking to all resource operations
2. Implement analytics aggregation service
3. Create analytics dashboard UI
4. Set up scheduled aggregation jobs
5. Test with sample data

### Phase 3: Workspace Hierarchy

1. Add WorkspaceRelation table
2. Implement hierarchy resolution service
3. Update authorization to check hierarchy
4. Create hierarchy management UI
5. Test with parent-child scenarios

### Phase 4: Custom Roles

1. Add CustomRole and RolePermission tables
2. Implement permission resolution service
3. Update authorization to use custom roles
4. Create role management UI
5. Migrate existing memberships to default roles

### Phase 5: Budget Controls

1. Add BudgetLimit, BudgetAlert, BudgetApproval tables
2. Implement budget checking service
3. Integrate with billing system
4. Create budget configuration UI
5. Set up budget monitoring jobs

### Phase 6: Backup/Restore

1. Add BackupJob and RestoreJob tables
2. Implement backup service
3. Implement restore service
4. Create backup/restore UI
5. Test with real workspaces

### Phase 7: Workspace Merger

1. Add WorkspaceMerger table
2. Implement merger validation service
3. Implement merger execution service
4. Create merger UI
5. Test with sample workspaces

---

## Monitoring & Observability

### Metrics to Track

- Quota violation rate
- Budget alert triggers
- Analytics query latency
- Backup job success rate
- Restore job success rate
- Custom role usage
- Workspace hierarchy depth

### Alerts to Configure

- High quota violation rate
- Budget nearly exceeded alerts
- Backup job failures
- Restore job failures
- Analytics aggregation failures

---

## Documentation Requirements

### User Documentation

- How to configure resource quotas
- How to set budget limits
- How to use analytics dashboard
- How to create and manage custom roles
- How to set up workspace hierarchy
- How to create backups
- How to restore from backup

### Developer Documentation

- Quota enforcement API
- Budget control API
- Analytics API
- Custom role API
- Backup/restore API
- Workspace hierarchy API

### Admin Documentation

- Workspace merger procedures
- Backup retention policies
- Quota management best practices
- Budget management best practices

---

## Rollback Plan

If issues arise:

1. Disable new features via feature flags
2. Stop backup/restore jobs
3. Revert to default roles
4. Disable hierarchy resolution
5. Monitor for errors

---

## Success Criteria

- ✅ Resource quotas are enforced for all operations
- ✅ Budget alerts trigger correctly
- ✅ Analytics dashboard shows accurate data
- ✅ Workspace hierarchy works correctly
- ✅ Custom roles have proper permissions
- ✅ Backup jobs complete successfully
- ✅ Restore jobs restore data correctly
- ✅ Workspace merger works without data loss
- ✅ Performance targets met
- ✅ Security tests pass
- ✅ Documentation is complete

---

**Next Module:** [03-project-management.md](03-project-management.md)
