/**
 * Auth — resolve the current user to a role and gate actions.
 * -----------------------------------------------------------
 * The web app runs as the deployer (USER_DEPLOYING), but Session.getActiveUser()
 * still returns the real caller inside the @jumia.com domain — that is the email
 * we authorise against and stamp into the activity log.
 */

/** Callable from the client: who am I, and is the app provisioned yet. */
function getCurrentUser() {
  if (__me_) return __me_;
  var email = Session.getActiveUser().getEmail() || '';
  var setup = isSetupDone_();
  var u = { email: email, role: setup ? getRole(email) : null, isSetup: setup };
  u.canDash = setup ? canSeeDashboard_(u) : false;
  __me_ = u;
  return u;
}
var __me_ = null;   // resolved once per execution (the role comes from the 5-minute Users cache)

function isSetupDone_() {
  return !!(scriptProp_(PROP.CONFIG_SS) && scriptProp_(PROP.DATA_SS));
}

/**
 * Who may open the CFO dashboard: every Administrator, plus the emails listed in the
 * Settings row `dashboard_viewers` (comma-separated). Auditors never, even if listed —
 * the dashboard is Jumia's internal view of where the audit stands.
 */
function canSeeDashboard_(u) {
  if (!u || !u.email) return false;
  if (u.role === ROLES.AUDITOR) return false;
  if (u.role === ROLES.ADMIN) return true;
  var list = String(getSetting('dashboard_viewers') || '').toLowerCase().split(/[,;\s]+/).filter(String);
  return list.indexOf(String(u.email).toLowerCase()) !== -1;
}

/** Throw unless the current user holds one of `roles`. Returns the user on pass. */
function requireRole_(roles) {
  var u = getCurrentUser();
  if (!u.role || roles.indexOf(u.role) === -1) {
    throw new Error('Access denied — requires ' + roles.join(' or ') +
                    '. You are ' + (u.role || 'not registered') + '.');
  }
  return u;
}
