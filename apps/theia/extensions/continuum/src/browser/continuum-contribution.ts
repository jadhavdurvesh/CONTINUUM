import { injectable, inject } from '@theia/core/shared/inversify';
import {
  Command, CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry, MessageService
} from '@theia/core/lib/common';
import { CommonMenus, OpenerService } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';

/**
 * Opens the established CONTINUUM cloud workspace. Authentication, shared project
 * state, and model execution remain in the existing Supabase/Vercel architecture.
 * This URL is public configuration, never a credential.
 */
const CLOUD_WORKSPACE_URL = 'https://continuum-dun-ten.vercel.app/';

const OpenCloudWorkspaceCommand: Command = {
  id: 'continuum.openCloudWorkspace',
  label: 'CONTINUUM: Open Cloud Workspace'
};

const AboutContinuumCommand: Command = {
  id: 'continuum.about',
  label: 'CONTINUUM: About Cloud Architecture'
};

@injectable()
export class ContinuumCommandContribution implements CommandContribution, MenuContribution {
  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(OpenCloudWorkspaceCommand, {
      execute: async () => {
        try {
          await this.openerService.open(new URI(CLOUD_WORKSPACE_URL));
        } catch {
          this.messageService.error(
            'Could not open the CONTINUUM cloud workspace. Check your network connection and deployment URL.'
          );
        }
      }
    });

    registry.registerCommand(AboutContinuumCommand, {
      execute: () => this.messageService.info(
        'CONTINUUM uses Supabase for authentication and shared project data, with AI agent orchestration on Vercel. Provider credentials remain server-side; the desktop app does not request or store AI provider keys.'
      )
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(CommonMenus.FILE_OPEN, {
      commandId: OpenCloudWorkspaceCommand.id,
      label: 'Open CONTINUUM Cloud Workspace'
    });
  }
}
