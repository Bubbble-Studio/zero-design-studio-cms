/**
 * Upload provider. Cloudinary → Cloudflare R2 migration, Phase 1
 * (docs/cloudinary-to-r2-migration.md).
 *
 * Gated on UPLOAD_PROVIDER so that merging and deploying this changes nothing: new
 * uploads keep going to Cloudinary until UPLOAD_PROVIDER=r2 is set in Coolify.
 * Rolling back is the same switch in reverse — existing rows keep working either way,
 * because each row stores its own absolute URL.
 */
const R2_ENV = [
  "CLOUDFLARE_R2_ACCESS_KEY_ID",
  "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
  "CLOUDFLARE_R2_ENDPOINT",
  "CLOUDFLARE_R2_BUCKET",
  "CLOUDFLARE_R2_PUBLIC_URL",
];

const cloudinaryUpload = (env) => ({
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
});

const r2Upload = (env) => ({
  // Strapi stores this exact string in files.provider, and only routes a delete to
  // the provider when the row's value matches — the migration script writes the same.
  provider: "strapi-provider-cloudflare-r2",
  providerOptions: {
    // Spread straight into `new AWS.S3(...)` (aws-sdk v2) by the provider.
    accessKeyId: env("CLOUDFLARE_R2_ACCESS_KEY_ID"),
    secretAccessKey: env("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
    endpoint: env("CLOUDFLARE_R2_ENDPOINT"),
    signatureVersion: "v4",
    // Path-style (<endpoint>/<bucket>/<key>), the same addressing the migration script
    // uses — so a script test round also proves the provider's connection settings.
    s3ForcePathStyle: true,
    params: {
      Bucket: env("CLOUDFLARE_R2_BUCKET"),
      // R2 ignores this on write and serves it back, so assets cache at the edge.
      CacheControl: "public, max-age=31536000, immutable",
    },
    // URL written to the DB. Must be the custom domain, never *.r2.dev (rate-limited).
    // Also required for uploads over 5 MB.
    cloudflarePublicAccessUrl: env("CLOUDFLARE_R2_PUBLIC_URL"),
    // MUST stay false. The provider's delete() always uses the folder-prefixed key;
    // pool: true would upload flat keys and make every delete from the Media Library
    // silently miss.
    pool: false,
  },
  actionOptions: {
    upload: {},
    uploadStream: {},
    delete: {},
  },
});

const uploadConfig = (env) => {
  if (env("UPLOAD_PROVIDER", "cloudinary") !== "r2") return cloudinaryUpload(env);

  const missing = R2_ENV.filter((k) => !env(k));
  if (missing.length) {
    // Deliberately not a throw: a boot failure would take the public site's API down.
    // Uploads keep working on Cloudinary, and the Phase 1 test upload (URL still on
    // res.cloudinary.com) makes the misconfiguration obvious.
    console.error(
      `[upload] UPLOAD_PROVIDER=r2 but ${missing.join(", ")} not set — staying on Cloudinary.`
    );
    return cloudinaryUpload(env);
  }
  return r2Upload(env);
};

export default ({ env }) => ({
  upload: {
    config: uploadConfig(env),
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
