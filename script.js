"use strict";

let menu = document.getElementById("menu-toggle");
let nav = document.getElementById("nav-links");
let grid = document.getElementById("projects-grid");
let count = document.getElementById("repo-count");
let year = document.getElementById("year");

if (year) year.textContent = new Date().getFullYear();

function closeMenu() {
  if (!menu || !nav) return;
  menu.classList.remove("active");
  nav.classList.remove("open");
  menu.setAttribute("aria-expanded", "false");
}

if (menu && nav) {
  menu.addEventListener("click", () => {
    let open = menu.getAttribute("aria-expanded") === "true";
    menu.classList.toggle("active", !open);
    nav.classList.toggle("open", !open);
    menu.setAttribute("aria-expanded", String(!open));
  });

  nav.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", closeMenu);
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeMenu();
  });

  document.addEventListener("click", event => {
    if (!menu.contains(event.target) && !nav.contains(event.target)) closeMenu();
  });
}

let elements = document.querySelectorAll(".reveal");

if ("IntersectionObserver" in window) {
  let observer = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });

  elements.forEach(element => observer.observe(element));
} else {
  elements.forEach(element => element.classList.add("visible"));
}

function create(tag, cls, text) {
  let el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function createCard(repo) {
  let card = create("article", "project-card");
  let top = create("div", "project-topline");
  let title = create("h3", "project-name");
  let link = create("a", "", repo.name);

  link.href = repo.html_url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  title.appendChild(link);
  top.appendChild(title);

  let label = repo.archived ? "Archived" : "Public";
  let badge = create("span", "project-visibility", label);

  if (repo.archived) {
    badge.classList.add("project-archived");
    badge.title = "This repository is archived and read-only";
  }

  top.appendChild(badge);
  card.appendChild(top);

  card.appendChild(create(
    "p",
    "project-description",
    repo.description || "No description provided yet."
  ));

  let footer = create("div", "project-footer");

  if (repo.language) {
    let language = create("span", "project-language");
    let dot = create("span", "language-dot");
    dot.setAttribute("aria-hidden", "true");
    language.appendChild(dot);
    language.appendChild(document.createTextNode(repo.language));
    footer.appendChild(language);
  }

  footer.appendChild(create("span", "", `★ ${repo.stargazers_count}`));
  footer.appendChild(create("span", "", `⑂ ${repo.forks_count}`));

  let updated = new Date(repo.updated_at);

  if (!Number.isNaN(updated.getTime())) {
    footer.appendChild(create(
      "span",
      "",
      `Updated ${updated.toLocaleDateString("en", {
        day: "numeric",
        month: "short",
        year: "numeric"
      })}`
    ));
  }

  card.appendChild(footer);
  return card;
}

async function loadRepos() {
  if (!grid || !count) return;

  grid.replaceChildren(create("div", "loading-card", "Loading repositories..."));

  try {
    let repos = [];
    let page = 1;
    let more = true;

    while (more) {
      let response = await fetch(
        `https://api.github.com/users/toxic-devil/repos?type=owner&sort=updated&per_page=100&page=${page}`,
        { headers: { Accept: "application/vnd.github+json" } }
      );

      if (!response.ok) throw new Error(`GitHub returned status ${response.status}`);

      let data = await response.json();
      if (!Array.isArray(data)) throw new Error("Unexpected GitHub API response");

      repos.push(...data);
      more = data.length === 100;
      page++;
    }

    repos = repos
      .filter(repo => !repo.private && !repo.fork)
      .sort((a, b) => {
        if (a.archived !== b.archived) return Number(a.archived) - Number(b.archived);
        return new Date(b.updated_at) - new Date(a.updated_at);
      });

    grid.replaceChildren();

    if (!repos.length) {
      grid.appendChild(create("div", "empty-card", "No public repositories found."));
      count.textContent = "0 public repositories";
      return;
    }

    let fragment = document.createDocumentFragment();

    repos.forEach(repo => fragment.appendChild(createCard(repo)));
    grid.appendChild(fragment);

    let archived = repos.filter(repo => repo.archived).length;
    count.textContent = `${repos.length} public repositories · ${archived} archived`;
  } catch (error) {
    console.error("Could not load GitHub repositories:", error);

    grid.replaceChildren(create(
      "div",
      "empty-card",
      "Couldn't load repositories. Please visit GitHub to see all projects."
    ));

    count.textContent = "Repositories unavailable";
  }
}

loadRepos();
