export default ({ env }) => ({
  upload: {
    config: {
      provider: "cloudinary",
      providerOptions: {
        cloud_name: env("CLOUDINARY_NAME"),
        api_key: env("CLOUDINARY_KEY"),
        api_secret: env("CLOUDINARY_SECRET"),
      },
      actionOptions: {
        upload: {},
        uploadStream: {},
        delete: {},
      },
    },
  },
  email: {
    config: {
      provider: "cloudflare",
      providerOptions: {
        accountId: env("CLOUDFLARE_ACCOUNT_ID"),
        apiToken: env("CLOUDFLARE_EMAIL_API_TOKEN"),
        apiBaseUrl: env("CLOUDFLARE_API_BASE_URL", "https://api.cloudflare.com/client/v4"),
      },
      settings: {
        defaultFrom: env("CLOUDFLARE_EMAIL_DEFAULT_FROM", "forms@mail.zerodesignstudios.com"),
        defaultReplyTo: env("CLOUDFLARE_EMAIL_DEFAULT_REPLY_TO", "info@zerodesignstudios.com"),
      },
    },
  },
  ezforms: {
    config: {
      captchaProvider: {
        name: "none",
      },
      notificationProviders: [
        {
          name: "email",
          enabled: true,
          config: {
            subject: "New Contact Form Submission on Website", // Optional
            from: env(
              "CLOUDFLARE_EMAIL_DEFAULT_FROM",
              "forms@mail.zerodesignstudios.com"
            ), // Required
          },
        },
      ],
    },
  },
  seo: {
    enabled: true,
  },
});
