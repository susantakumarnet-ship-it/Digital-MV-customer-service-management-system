import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { AuditPage } from '@/features/audit/audit-page';
import { RequireAuth, RequirePermission } from '@/features/auth/guards';
import { LoginPage } from '@/features/auth/login-page';
import { ForcedMfaSetupPage } from '@/features/auth/mfa-setup';
import { ForcedChangePasswordPage, ForgotPasswordPage, ResetPasswordPage } from '@/features/auth/password-pages';
import { DashboardPage } from '@/features/dashboard/role-dashboard';
import { MasterResourcePage } from '@/features/masters/master-resource-page';
import { MastersIndexPage } from '@/features/masters/masters-index-page';
import { NotificationsPage } from '@/features/notifications/notifications-page';
import { ProfilePage } from '@/features/profile/profile-page';
import { RolesPage } from '@/features/roles/roles-page';
import { SettingsPage } from '@/features/settings/settings-page';
import { UserDetailPage } from '@/features/users/user-detail-page';
import { UsersPage } from '@/features/users/users-page';
import { WorkflowsPage } from '@/features/workflows/workflows-page';
import { ComplaintDetailPage } from '@/features/complaints/complaint-detail-page';
import { ComplaintsListPage } from '@/features/complaints/complaints-list-page';
import { NewComplaintPage } from '@/features/complaints/new-complaint-page';
import { PublicComplaintPage } from '@/features/complaints/public-complaint-page';
import { EmptyState } from '@/components/states';
import { AppLayout } from './layout/app-layout';
import { RouteError } from './route-error';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/report', element: <PublicComplaintPage />, errorElement: <RouteError /> },
  { path: '/reset-password', element: <ResetPasswordPage mode="reset" /> },
  { path: '/activate', element: <ResetPasswordPage mode="activate" /> },
  {
    path: '/change-password',
    element: (
      <RequireAuth>
        <ForcedChangePasswordPage />
      </RequireAuth>
    ),
  },
  {
    path: '/mfa-setup',
    element: (
      <RequireAuth>
        <ForcedMfaSetupPage />
      </RequireAuth>
    ),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'profile', element: <ProfilePage /> },
      {
        path: 'complaints',
        element: (
          <RequirePermission all={['complaint.read']}>
            <ComplaintsListPage />
          </RequirePermission>
        ),
      },
      {
        path: 'complaints/new',
        element: (
          <RequirePermission all={['complaint.create']}>
            <NewComplaintPage />
          </RequirePermission>
        ),
      },
      {
        path: 'complaints/:id',
        element: (
          <RequirePermission all={['complaint.read']}>
            <ComplaintDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: 'notifications',
        element: (
          <RequirePermission all={['notification.read']}>
            <NotificationsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'admin',
        element: <Outlet />,
        children: [
          { index: true, element: <Navigate to="/" replace /> },
          {
            path: 'users',
            element: (
              <RequirePermission all={['user.read']}>
                <UsersPage />
              </RequirePermission>
            ),
          },
          {
            path: 'users/:id',
            element: (
              <RequirePermission all={['user.read']}>
                <UserDetailPage />
              </RequirePermission>
            ),
          },
          {
            path: 'roles',
            element: (
              <RequirePermission all={['role.read']}>
                <RolesPage />
              </RequirePermission>
            ),
          },
          {
            path: 'masters',
            element: (
              <RequirePermission all={['master.read']}>
                <MastersIndexPage />
              </RequirePermission>
            ),
          },
          {
            path: 'masters/:resource',
            element: (
              <RequirePermission all={['master.read']}>
                <MasterResourcePage />
              </RequirePermission>
            ),
          },
          {
            path: 'settings',
            element: (
              <RequirePermission all={['settings.read']}>
                <SettingsPage />
              </RequirePermission>
            ),
          },
          {
            path: 'workflows',
            element: (
              <RequirePermission all={['workflow.read']}>
                <WorkflowsPage />
              </RequirePermission>
            ),
          },
          {
            path: 'audit',
            element: (
              <RequirePermission all={['audit.read']}>
                <AuditPage />
              </RequirePermission>
            ),
          },
        ],
      },
      { path: '*', element: <EmptyState title="Page not found" description="The page you are looking for does not exist." /> },
    ],
  },
]);
