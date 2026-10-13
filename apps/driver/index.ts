import { registerRootComponent } from 'expo';

import { AppRoot } from './src/app/AppRoot';
import { configurePushNotifications } from './src/platform/pushNotifications';

configurePushNotifications();
registerRootComponent(AppRoot);
