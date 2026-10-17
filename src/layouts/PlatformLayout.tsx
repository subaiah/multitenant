import AppShell, { Mark } from '../components/AppShell';
import { APP_NAME } from '../lib/brand';

export default function PlatformLayout() {
  return (
    <AppShell
      portal="PLATFORM"
      mark={<Mark label={APP_NAME} />}
      title={APP_NAME}
      subtitle="Platform"
      notificationsPath="/platform/notifications"
    />
  );
}
