import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { ContinuumCommandContribution } from './continuum-contribution';

export default new ContainerModule(bind => {
  bind(ContinuumCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(ContinuumCommandContribution);
  bind(MenuContribution).toService(ContinuumCommandContribution);
});
