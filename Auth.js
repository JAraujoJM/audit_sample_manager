/**
 * Auth — resolve the current user to a role and gate actions.
 * -----------------------------------------------------------
 * The web app runs as the deployer (USER_DEPLOYING), but Session.getActiveUser()
 * still returns the real caller inside the @jumia.com domain — that is the email
 * we authorise against and stamp into the activity log.
 */

/** Callable from the client: who am I, and is the app provisioned yet. */
function getCurrentUser() {
  var email = Session.getActiveUser().getEmail() || '';
  return {
    email: email,
    role: isSetupDone_() ? getRole(email) : null,
    isSetup: isSetupDone_()
  };
}

function isSetupDone_() {
  var p = PropertiesService.getScriptProperties();
  return !!(p.getProperty(PROP.CONFIG_SS) && p.getProperty(PROP.DATA_SS));
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
