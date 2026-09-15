# Molecular component duplicate inventory

Scanned 929 maintained React files. 110 exported compositions have a recognized molecular role and at least two atomic dependencies.

Clusters share both a role and an atomic dependency signature. Detection creates a review queue; this committed report contains only final dispositions based on product behavior, state ownership, and responsive layout.

## Canonical molecule contracts

These owners are fail-closed contracts. The audit fails if an owner disappears, drops a required canonical atom, loses a named consumer, or loses its rendered story or behavioral test.

| Contract | Canonical owner | Maintained references | Representative proof | Responsibility |
| --- | --- | ---: | --- | --- |
| auth-result-shell | `AuthResultShell` in `packages/ui/src/cloud/public-pages/pages/auth/auth-result-shell.tsx` | 2 | `packages/ui/src/cloud/public-pages/pages/auth/auth-result-shell.stories.tsx`<br>`packages/ui/src/cloud/public-pages/pages/auth/auth-result-shell.test.tsx` | Full-page surface, centered card, and content geometry for authentication results. |
| connection-capability-tile | `ConnectionCapabilityTile` in `packages/ui/src/cloud/connectors/connection-capability-tile.tsx` | 2 | `packages/ui/src/cloud/connectors/connection-capability-tile.stories.tsx`<br>`packages/ui/src/cloud/connectors/connection-capability-tile.test.tsx` | Icon, title, and description hierarchy for connector capability grids. |
| content-state | `ContentState` in `packages/ui/src/components/composites/page-panel/content-state.tsx` | 5 | `packages/ui/src/components/composites/page-panel/content-state.stories.tsx`<br>`packages/ui/src/components/composites/page-panel/content-state.test.tsx` | Empty and loading presentation inside page-panel placements. |
| settings-row | `SettingsRow` in `packages/ui/src/components/settings/settings-layout.tsx` | 42 | `packages/ui/src/components/settings/settings-layout.stories.tsx`<br>`packages/ui/src/components/settings/settings-layout.test.tsx` | Label, description, control, and navigation alignment for settings. |
| action-list-row | `ActionListRow` in `packages/ui/src/components/shared/ActionListRow.tsx` | 2 | `packages/ui/src/components/shared/ActionListRow.stories.tsx`<br>`packages/ui/src/components/shared/ActionListRow.test.tsx` | Button, link, and static list rows with shared content slots. |

## Duplicate review queue

| Role | Atomic dependencies | Components | Decision |
| --- | --- | ---: | --- |
| form | button, input | 4 | distinct-domain-compositions |
| row | button, card | 4 | distinct-domain-compositions |
| dialog | button, dialog | 3 | distinct-domain-compositions |
| dialog | button, dialog, input | 3 | distinct-domain-compositions |
| form | button, input, textarea | 3 | distinct-domain-compositions |
| list | badge, button, card | 3 | distinct-domain-compositions |
| panel | button, card, input | 3 | distinct-domain-compositions |
| panel | button, input | 3 | distinct-domain-compositions |
| card | badge, button, card, checkbox, dialog, spinner | 2 | distinct-domain-compositions |
| card | button, input | 2 | distinct-domain-compositions |
| dialog | alert, button, card | 2 | distinct-domain-compositions |
| row | button, card, statusDot | 2 | distinct-domain-compositions |

## Reviewed clusters

### form: button + input

- `TriggerForm` in `packages/ui/src/components/pages/TriggerForm.tsx:231`
- `TagEditor` in `packages/ui/src/components/ui/tag-editor.tsx:29`
- `LoginForm` in `packages/ui/src/login/components/LoginForm.tsx:180`
- `MonthlyScheduleEditor` in `plugins/plugin-personal-assistant/src/components/family-operations/MonthlyScheduleEditor.tsx:8`
- Fingerprint: `sha256:dabb8a0a48c8ffa8aa2ca60e407ccb9a3260d7951005a8b4824602a47d885519`
- Decision: **distinct-domain-compositions**. Workflow-trigger configuration, tag editing, login and monthly family timing share canonical Button and Input primitives. Login owns credential challenges and session handoff; tag editing emits string lists; TriggerForm owns workflow definitions, execution history and templates. MonthlyScheduleEditor edits the existing family ScheduledTask through its owner adapter, preserves timezone and lifecycle state, and focuses save failures. These forms have separate domain contracts.

### row: button + card

- `SidebarItem` in `packages/ui/src/components/composites/sidebar/sidebar-content.tsx:174`
- `SettingsRow` in `packages/ui/src/components/settings/settings-layout.tsx:298`
- `ActionListRow` in `packages/ui/src/components/shared/ActionListRow.tsx:115`
- `ReasoningCell` in `plugins/plugin-task-coordinator/src/orchestrator-reasoning.tsx:96`
- Fingerprint: `sha256:982159e726ae366cad541734d281ae30c74bbff4c06577ae8203a7786d25581c`
- Decision: **distinct-domain-compositions**. Sidebar and settings rows share atomic controls but own different selection, status, and lifecycle contracts.

### dialog: button + dialog

- `EditSkillModal` in `packages/ui/src/components/pages/skill-detail-panel.tsx:35`
- `ConfirmDialog` in `packages/ui/src/components/ui/confirm-dialog.tsx:35`
- `EventEditorDrawer` in `plugins/plugin-calendar/src/components/EventEditorDrawer.tsx:527`
- Fingerprint: `sha256:20da2a24641576e0c73aca23d9042d1a865c4885e106f53a792be2624a8fe4d7`
- Decision: **distinct-domain-compositions**. The skill editor owns source loading and saving; the confirmation dialog emits a caller-owned decision; the calendar editor owns provider mutations and timed or all-day date validation. Its timing fieldset does not introduce a shared dialog lifecycle.

### dialog: button + dialog + input

- `SaveCommandModal` in `packages/ui/src/components/chat/SaveCommandModal.tsx:37`
- `ChatConversationRenameDialog` in `packages/ui/src/components/composites/chat/chat-conversation-rename-dialog.tsx:41`
- `PromptDialog` in `packages/ui/src/components/ui/confirm-dialog.tsx:95`
- Fingerprint: `sha256:baf8c850cab849f7ceb04e8ad6ff718d448b16337368fe64e9786a51414a8fa5`
- Decision: **distinct-domain-compositions**. Command persistence, conversation renaming, and generic prompting have different validation, pending, error, and result contracts. Their stable shared behavior already belongs to Dialog, Input, and Button.

### form: button + input + textarea

- `CockpitNewSessionForm` in `packages/ui/src/components/cockpit/CockpitNewSessionForm.tsx:64`
- `AgreementProposalEditor` in `plugins/plugin-personal-assistant/src/components/family-operations/AgreementProposalEditor.tsx:6`
- `PacketDraftEditor` in `plugins/plugin-personal-assistant/src/components/family-operations/PacketDraftEditor.tsx:6`
- Fingerprint: `sha256:37d6191bc5906dd75f77c0fa0c8b1a0db01057621e86408b9e2fef230f3962c4`
- Decision: **distinct-domain-compositions**. Session creation owns model, mode, and initial prompt selection. Family email revision owns immutable draft versions and stale approval rejection. Agreement correction owns literal page citations, unapproved proposals, and recovery of a saved proposal without resubmitting it. These distinct domain transitions share canonical field and button atoms, not one form lifecycle.

### list: badge + button + card

- `CredentialsList` in `packages/ui/src/cloud/organization/credentials-list.tsx:78`
- `MembersList` in `packages/ui/src/cloud/organization/members-list.tsx:53`
- `PendingInvitesList` in `packages/ui/src/cloud/organization/pending-invites-list.tsx:42`
- Fingerprint: `sha256:2f31c5b3253f58727078819d94a3f16732986ed376b3fcb759da11ffb6c44d0b`
- Decision: **distinct-domain-compositions**. The lists share canonical status, action, and surface atoms, but their item identity, loading, selection, and mutation contracts remain domain-specific.

### panel: button + card + input

- `MessageSearchPanel` in `packages/ui/src/components/chat/message-search/MessageSearchPanel.tsx:50`
- `TelegramAccountConnectorPanel` in `packages/ui/src/components/connectors/TelegramAccountConnectorPanel.tsx:72`
- `DesktopTalkModePanel` in `packages/ui/src/components/settings/VoiceConfigView.tsx:64`
- Fingerprint: `sha256:4a7d6f88b5646c000931d32d3acd7c6fa62ebd23b2506bc7c79785d65f8afb6f`
- Decision: **distinct-domain-compositions**. These panels use the canonical Card boundary but retain unrelated search, connector, and release workflows.

### panel: button + input

- `TelegramBotSetupPanel` in `packages/ui/src/components/connectors/TelegramBotSetupPanel.tsx:35`
- `ReleaseNotesSection` in `packages/ui/src/components/release-center/sections.tsx:241`
- `FamilyDeletionPanel` in `plugins/plugin-personal-assistant/src/components/family-operations/FamilyDeletionPanel.tsx:29`
- Fingerprint: `sha256:7c58e0f8693e13ed13c204e2cd438118f008bca8e594d9a96dc8c59e82a56648`
- Decision: **distinct-domain-compositions**. Telegram setup validates connector credentials and establishes a session. Release notes configure and open a native browser window. Family deletion binds owner confirmation to a reviewed snapshot and recovers durable deletion jobs. These distinct domain lifecycles compose the canonical Button and Input primitives.

### card: badge + button + card + checkbox + dialog + spinner

- `AccountCard` in `packages/ui/src/components/accounts/AccountCard.tsx:174`
- `ConnectorAccountCard` in `packages/ui/src/components/connectors/ConnectorAccountCard.tsx:163`
- Fingerprint: `sha256:8ea2bedecb10b2882b60f474c9b054d420536fbf591659a331133a4a65f69de4`
- Decision: **distinct-domain-compositions**. The credential-pool card owns priority ordering, provider usage windows, credential repair, and enabled opacity; the connector card owns selection/default state, capability grants, privacy/purpose, sync identity, and independent busy transitions. Their shared status, editing, controls, and confirmation behavior already comes from canonical atoms, while a shared slot shell would hide distinct state machines without removing domain logic.

### card: button + input

- `ChoiceWidget` in `packages/ui/src/components/chat/widgets/ChoiceWidget.tsx:60`
- `ConnectorCardWidget` in `packages/ui/src/components/chat/widgets/connector-card.tsx:83`
- Fingerprint: `sha256:c4da956164c8055bbd980c9578833a0ae0360feffa67f09a8357c6c854233dc1`
- Decision: **distinct-domain-compositions**. Domain purchase, chat choice, and connector cards only coincide at a broad dependency signature.

### dialog: alert + button + card

- `ContributeCredentialDialog` in `packages/ui/src/cloud/organization/contribute-credential-dialog.tsx:56`
- `InviteMemberDialog` in `packages/ui/src/cloud/organization/invite-member-dialog.tsx:66`
- Fingerprint: `sha256:6691c91cff13e2f52c953d92dbc15729b0939294fd4a3bad4d7609b488acf564`
- Decision: **distinct-domain-compositions**. The dialogs share canonical feedback and surface atoms while retaining unrelated validation, confirmation, and completion lifecycles.

### row: button + card + statusDot

- `ChatConversationItem` in `packages/ui/src/components/composites/chat/chat-conversation-item.tsx:126`
- `SidebarRailItem` in `packages/ui/src/components/composites/sidebar/sidebar-content.tsx:361`
- Fingerprint: `sha256:236a28db5d448c07bc5e53b5a99d01dcce8d13a80262b0781d4adebc69e3cac4`
- Decision: **distinct-domain-compositions**. Rail rows compose the same atomic status indicator while preserving domain-specific navigation and selection behavior.
