const panel = document.getElementById("workspace-panel");

const routes = {
  "/workspace/overview": {
    title: "Overview",
    body: "Overview is the default workspace tab.",
  },
  "/workspace/activity": {
    title: "Activity",
    body: "Activity shows a client-side route transition without a full page reload.",
  },
  "/workspace/details": {
    title: "Details",
    body: "Details is a third workspace state for pushState coverage.",
  },
};

function render(route) {
  const next = routes[route] ?? routes["/workspace/overview"];
  panel.innerHTML = `<h2>${next.title}</h2><p>${next.body}</p>`;
}

function navigate(route) {
  history.pushState({ route }, "", route);
  render(route);
}

document.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const route = target.dataset.route;

  if (!route) {
    return;
  }

  navigate(route);
});

window.addEventListener("popstate", () => {
  render(window.location.pathname);
});

render(window.location.pathname);
