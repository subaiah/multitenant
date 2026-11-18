/**
 * Platform settings: how the installation is set up, in one place. Email
 * delivery for now (set in the server's .env, tested from here); your own
 * notification choices stay on the Notifications page.
 */
import { Link } from 'react-router-dom';
import { Card, PageHeader } from '../components/ui';
import { PlatformEmail } from './Notifications';

export default function PlatformSettings() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Settings" description="How this installation is set up" />
      <PlatformEmail />
      <Card title="Your notifications" description="What you're told about, in the app and by email">
        <Link to="/platform/notifications?tab=preferences" className="text-sm text-blue-600 hover:text-blue-700">
          Choose what you get
        </Link>
      </Card>
    </div>
  );
}
