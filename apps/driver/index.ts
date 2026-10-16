import { registerRootComponent } from 'expo';

// The location task must be defined while the bundle loads, also when the system starts it without the screen.
import './src/platform/tracking';
import { AppRoot } from './src/app/AppRoot';
import { configurePushNotifications } from './src/platform/pushNotifications';

configurePushNotifications();
registerRootComponent(AppRoot);
