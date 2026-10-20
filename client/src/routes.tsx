import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { SessionProvider, useSession } from './lib/session';
import { Button, Card, EmptyState } from './components/ui';
import { AcceptInvitationPage } from './pages/AcceptInvitation';
import { BudgetsPage } from './pages/Budgets';
import { CalendarPage } from './pages/Calendar';
import { CategoriesPage } from './pages/Categories';
import { CreateOrganizationPage } from './pages/CreateOrganization';
import { DashboardPage } from './pages/Dashboard';
import { ForgotPasswordPage } from './pages/ForgotPassword';
import { ImportsPage } from './pages/Imports';
import { IntegrationsPage } from './pages/Integrations';
import { LoginPage } from './pages/Login';
import { NotFoundPage } from './pages/NotFound';
import { RegisterPage } from './pages/Register';
import { RemindersDuePage } from './pages/RemindersDue';
import { RemindersPage } from './pages/Reminders';
import { ResetPasswordPage } from './pages/ResetPassword';
import { SettingsPage } from './pages/Settings';
import { SubscriptionDetailPage } from './pages/SubscriptionDetail';
import { SubscriptionEditorPage } from './pages/SubscriptionEditor';
import { SubscriptionsPage } from './pages/Subscriptions';

function FullPageLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
      <span className="text-sm text-ink-muted">Loading RenewRadar…</span>
    </div>
  );
}

function FullPageMessage({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <EmptyState title={title} description={description} {...(action ? { action } : {})} />
      </Card>
    </div>
  );
}

function RequireSession({ children }: { children: ReactNode }) {
  const { user, loading, memberships } = useSession();
  if (loading) return <FullPageLoading />;
  if (!user) return <Navigate to="/login" replace />;
  if (memberships.length === 0) return <Navigate to="/welcome" replace />;
  return <>{children}</>;
}

function RequireOrganization({ children }: { children: ReactNode }) {
  const params = useParams();
  const navigate = useNavigate();
  const { memberships, activeOrganizationId, loading } = useSession();
  const organizationId = params.organizationId;

  if (loading) return <FullPageLoading />;
  if (!organizationId) return <Navigate to="/dashboard" replace />;
  if (!memberships.some((membership) => membership.organizationId === organizationId)) {
    return (
      <FullPageMessage
        title="Workspace not available"
        description="You are not a member of this workspace, or it no longer exists."
        action={
          <Button variant="primary" onClick={() => navigate(`/${activeOrganizationId}/dashboard`)}>
            Go to my dashboard
          </Button>
        }
      />
    );
  }
  return <>{children}</>;
}

function RedirectToFirstOrganization() {
  const { memberships, loading } = useSession();
  if (loading) return <FullPageLoading />;
  const first = memberships[0];
  if (!first) return <Navigate to="/welcome" replace />;
  return <Navigate to={`/${first.organizationId}/dashboard`} replace />;
}

function OrganizationLayout() {
  return (
    <AppShell>
      <Routes>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="subscriptions" element={<SubscriptionsPage />} />
        <Route path="subscriptions/new" element={<SubscriptionEditorPage />} />
        <Route path="subscriptions/:subscriptionId" element={<SubscriptionDetailPage />} />
        <Route path="subscriptions/:subscriptionId/edit" element={<SubscriptionEditorPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="reminders" element={<RemindersPage />} />
        <Route path="reminders/due" element={<RemindersDuePage />} />
        <Route path="budgets" element={<BudgetsPage />} />
        <Route path="categories" element={<CategoriesPage />} />
        <Route path="imports" element={<ImportsPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}

export function AppRouter() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
        <Route path="/welcome" element={<RequireSession><CreateOrganizationPage /></RequireSession>} />
        <Route path="/dashboard" element={<RequireSession><RedirectToFirstOrganization /></RequireSession>} />
        <Route
          path="/:organizationId"
          element={
            <RequireSession>
              <RequireOrganization>
                <OrganizationLayout />
              </RequireOrganization>
            </RequireSession>
          }
        />
        <Route path="/" element={<RequireSession><RedirectToFirstOrganization /></RequireSession>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </SessionProvider>
  );
}