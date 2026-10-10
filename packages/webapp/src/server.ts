export default {
  fetch(): Response {
    return new Response(null, { status: 501 });
  },
} satisfies ExportedHandler<Env>;
