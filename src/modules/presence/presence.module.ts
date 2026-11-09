import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module.js"
import { AccessRequestsModule } from "../access-requests/access-requests.module.js"
import { SharedFoldersModule } from "../shared-folders/shared-folders.module.js"
import { PresenceController } from "./presence.controller.js"
import { PresenceEvents } from "./presence-events.js"
import { PresenceService } from "./presence.service.js"
import { PrivacySettingsEvents } from "./privacy-settings-events.js"
import { RelationshipEvents } from "./relationship-events.js"
import { InMemoryPresenceStore, PRESENCE_STORE } from "./presence-store.js"

@Module({
  imports: [AuthModule, SharedFoldersModule, AccessRequestsModule],
  controllers: [PresenceController],
  providers: [
    PresenceEvents,
    PrivacySettingsEvents,
    PresenceService,
    RelationshipEvents,
    { provide: PRESENCE_STORE, useClass: InMemoryPresenceStore },
  ],
  exports: [PresenceEvents, PrivacySettingsEvents, PresenceService, RelationshipEvents],
})
export class PresenceModule {}
