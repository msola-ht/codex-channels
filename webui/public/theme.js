(() => {
  let theme = "dark"
  try {
    if (localStorage.getItem("theme") === "light") theme = "light"
  } catch {}
  document.documentElement.classList.add(theme)
  document.documentElement.style.colorScheme = theme
})()
