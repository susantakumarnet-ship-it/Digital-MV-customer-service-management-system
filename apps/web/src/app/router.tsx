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
import { AssignmentBoardPage } from '@/features/work-orders/assignment-board-page';
import { WorkOrderDetailPage } from '@/features/work-orders/work-order-detail-page';
import { WorkOrdersListPage } from '@/features/work-orders/work-orders-list-page';
import { VisitDetailPage } from '@/features/visits/visit-detail-page';
import { VisitsListPage } from '@/features/visits/visits-list-page';
import { TimeCorrectionsPage } from '@/features/visits/time-corrections-page';
import { InspectionReportPage } from '@/features/inspections/inspection-report-page';
import { InspectionReportsListPage } from '@/features/inspections/inspection-reports-list-page';
import { TemplatesPage } from '@/features/inspections/templates-page';
import { TemporaryAssetsPage } from '@/features/inspections/temporary-assets-page';
import { ReviewQueuePage } from '@/features/reviews/review-queue-page';
import { ReviewWorkspacePage } from '@/features/reviews/review-workspace-page';
import { ComparePage } from '@/features/reviews/compare-page';
import { MaterialsListPage, StoreQueuePage } from '@/features/materials/materials-list-page';
import { MaterialRequestPage } from '@/features/materials/material-request-page';
import { InventoryPage, LedgerPage } from '@/features/materials/inventory-pages';
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
        path: 'work-orders',
        element: (
          <RequirePermission all={['workOrder.read']}>
            <WorkOrdersListPage />
          </RequirePermission>
        ),
      },
      {
        path: 'work-orders/board',
        element: (
          <RequirePermission all={['workOrder.assign']}>
            <AssignmentBoardPage />
          </RequirePermission>
        ),
      },
      {
        path: 'work-orders/:id',
        element: (
          <RequirePermission all={['workOrder.read']}>
            <WorkOrderDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: 'visits',
        element: (
          <RequirePermission all={['visit.read']}>
            <VisitsListPage />
          </RequirePermission>
        ),
      },
      {
        path: 'visits/:id',
        element: (
          <RequirePermission all={['visit.read']}>
            <VisitDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: 'materials',
        element: (
          <RequirePermission all={['material.read']}>
            <MaterialsListPage />
          </RequirePermission>
        ),
      },
      {
        path: 'materials/:id',
        element: (
          <RequirePermission all={['material.read']}>
            <MaterialRequestPage />
          </RequirePermission>
        ),
      },
      {
        path: 'store',
        element: (
          <RequirePermission all={['inventory.issue']}>
            <StoreQueuePage />
          </RequirePermission>
        ),
      },
      {
        path: 'inventory',
        element: (
          <RequirePermission all={['inventory.read']}>
            <InventoryPage />
          </RequirePermission>
        ),
      },
      {
        path: 'inventory/ledger',
        element: (
          <RequirePermission all={['inventory.read']}>
            <LedgerPage />
          </RequirePermission>
        ),
      },
      {
        path: 'time-corrections',
        element: (
          <RequirePermission any={['visit.approveCorrection', 'visit.requestCorrection']}>
            <TimeCorrectionsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'inspection-reports',
        element: (
          <RequirePermission all={['inspection.read']}>
            <InspectionReportsListPage />
          </RequirePermission>
        ),
      },
      {
        path: 'inspection-reports/:id',
        element: (
          <RequirePermission all={['inspection.read']}>
            <InspectionReportPage />
          </RequirePermission>
        ),
      },
      {
        path: 'inspection-reports/:id/compare',
        element: (
          <RequirePermission all={['inspection.read']}>
            <ComparePage />
          </RequirePermission>
        ),
      },
      {
        path: 'reviews',
        element: (
          <RequirePermission any={['inspection.approve', 'inspection.return']}>
            <ReviewQueuePage />
          </RequirePermission>
        ),
      },
      {
        path: 'reviews/:id',
        element: (
          <RequirePermission all={['inspection.read']}>
            <ReviewWorkspacePage />
          </RequirePermission>
        ),
      },
      {
        path: 'inspections/temporary-assets',
        element: (
          <RequirePermission all={['inspection.reviewTempAsset']}>
            <TemporaryAssetsPage />
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
            path: 'checklists',
            element: (
              <RequirePermission all={['inspection.manageTemplates']}>
                <TemplatesPage />
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
