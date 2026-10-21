import { injectable, inject } from '@theia/core/shared/inversify';
import {
  Command, CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry, MessageService
} from '@theia/core/lib/common';
import { ApplicationShell, CommonMenus, OpenerService, WidgetManager } from '@theia/core/lib/browser';
import { ContinuumCloudWidget } from './continuum-cloud-widget';
import URI from '@theia/core/lib/common/uri';

const CLOUD_WORKSPACE_URL = 'https://continuum-dun-ten.vercel.app/';

const OpenCloudPanelCommand: Command = {
  id: 'continuum.openCloudPanel',
  label: 'CONTINUUM: Open Cloud Panel'
};

const OpenCloudWorkspaceCommand: Command = {
  id: 'continuum.openCloudWorkspace',
  label: 'CONTINUUM: Open Cloud Dashboard'
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

  @inject(WidgetManager)
  protected readonly widgetManager!: WidgetManager;

  @inject(ApplicationShell)
  protected readonly applicationShell!: ApplicationShell;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(OpenCloudPanelCommand, {
      execute: async () => {
        try {
          const widget = await this.widgetManager.getOrCreateWidget<ContinuumCloudWidget>(ContinuumCloudWidget.ID);
          if (!widget.isAttached) {
            await this.applicationShell.addWidget(widget, { area: 'right' });
          }
          await this.applicationShell.activateWidget(widget.id);
        } catch {
          this.messageService.error('Could not open CONTINUUM Cloud. Check the IDE installation and restart CONTINUUM.');
        }
      }
    });

    registry.registerCommand(OpenCloudWorkspaceCommand, {
      execute: async () => {
        try {
          await this.openerService.open(new URI(CLOUD_WORKSPACE_URL));
        } catch {
          this.messageService.error(
            'Could not open the CONTINUUM cloud dashboard. Check your network connection and deployment URL.'
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
      commandId: OpenCloudPanelCommand.id,
      label: 'Open CONTINUUM Cloud Panel'
    });
    menus.registerMenuAction(CommonMenus.FILE_OPEN, {
      commandId: OpenCloudWorkspaceCommand.id,
      label: 'Open CONTINUUM Cloud Dashboard'
    });
  }
}
