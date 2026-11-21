import { useApi } from '../hooks/useApi';
import { apiDelete, apiPatch, apiPost } from '../lib/api-client';
import { useAuth } from '../contexts/AuthContext';
import { DataView, PageHeader } from '../components/ui';
import { AccessRules, type AccessRule, type RuleInput, type TryResult } from '../components/AccessRules';

/** The organization's own access rules (backend lib/access-rules.ts), on top of the platform's */
export default function AccessRulesPage() {
  const { hasPermission } = useAuth();
  const rules = useApi<{ policies: AccessRule[] }>('/policies?limit=100');
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Access rules" description="Refuse what roles allow in some circumstances: outside working hours, from outside your network, for some people" />
      <DataView {...rules}>
        {({ policies }) => (
          <AccessRules
            title="Your organization's rules"
            description="Checked after the platform's own rules, which you can't make exceptions to."
            rules={policies}
            canManage={hasPermission('policies:manage')}
            onSave={async (input: RuleInput, id?: string) => {
              const body = { ...input, description: input.description ?? undefined };
              if (id) await apiPatch(`/policies/${id}`, body);
              else await apiPost('/policies', body);
              await rules.reload();
            }}
            onDelete={async (id) => { await apiDelete(`/policies/${id}`); await rules.reload(); }}
            onTry={({ email, action, ip, at }) => apiPost<TryResult>('/policies/evaluate', { email, action, context: { ...(ip && { ip }), ...(at && { at }) } })}
          />
        )}
      </DataView>
    </div>
  );
}
