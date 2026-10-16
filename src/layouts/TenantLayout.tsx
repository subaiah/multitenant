import AppShell, { Mark } from '../components/AppShell';
import { useAuth } from '../contexts/AuthContext';

export default function TenantLayout() {
  const { tenant } = useAuth();
  const name = tenant?.name ?? 'Your organization';
  return (
    <AppShell
      portal="TENANT"
      mark={<Mark label={name} color={tenant?.primaryColor} logoUrl={tenant?.logoUrl} />}
      title={name}
      subtitle="Organization"
      notificationsPath="/notifications"
    />
  );
}
