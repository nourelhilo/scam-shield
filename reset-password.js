const form = document.querySelector("#reset-form");
const password = document.querySelector("#new-password");
const confirmation = document.querySelector("#confirm-password");
const submit = form.querySelector("button");
const statusMessage = document.querySelector("#reset-status");

const url = new URL(window.location.href);
const token = url.searchParams.get("token");
if (url.searchParams.has("token")) {
  url.searchParams.delete("token");
  window.history.replaceState(null, "", url);
}

function showStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("is-error", isError);
}

if (token && /^pr_[A-Za-z0-9_-]{43}$/.test(token)) {
  form.hidden = false;
} else {
  showStatus("This reset link is invalid. Open the link from your reset email.", true);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (password.value.trim().length < 10) {
    showStatus("Enter at least 10 characters excluding leading and trailing spaces.", true);
    password.focus();
    return;
  }
  if (password.value !== confirmation.value) {
    showStatus("The passwords do not match.", true);
    confirmation.focus();
    return;
  }

  submit.disabled = true;
  showStatus("Resetting your password…");
  try {
    const response = await fetch("/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: password.value }),
    });
    if (!response.ok) {
      const body = await response.json();
      showStatus(body.error?.message || "Password reset failed. Try again.", true);
      return;
    }
    form.reset();
    form.hidden = true;
    document.querySelector("#reset-help").hidden = true;
    showStatus("Your password was changed. You can now sign in with your new password.");
  } catch {
    showStatus("Could not reach ScamShield. Try again.", true);
  } finally {
    submit.disabled = false;
  }
});
