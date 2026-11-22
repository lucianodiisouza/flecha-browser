if (!process.env.CI && process.env.NODE_ENV !== 'production') {
  const { default: installHooks } = await import('husky');
  const message = installHooks();

  if (message) console.log(message);
}
