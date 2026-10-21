import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { WidgetFactory } from '@theia/core/lib/browser';
import { ContinuumCommandContribution } from './continuum-contribution';
import { ContinuumCloudWidget } from './continuum-cloud-widget';

export default new ContainerModule(bind => {
  bind(ContinuumCloudWidget).toSelf().inSingletonScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: ContinuumCloudWidget.ID,
    createWidget: () => ctx.container.get<ContinuumCloudWidget>(ContinuumCloudWidget)
  })).inSingletonScope();

  bind(ContinuumCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(ContinuumCommandContribution);
  bind(MenuContribution).toService(ContinuumCommandContribution);
});
