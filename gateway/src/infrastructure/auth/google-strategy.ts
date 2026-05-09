import passport from 'passport';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { loadConfig } from '../../config/index.js';
import { getDatabase } from '../database/connection.js';
import { UserRepository } from '../../domain/users/repository.js';
import { logger } from '../../shared/logger.js';

export function configurePassport(): void {
  const config = loadConfig();

  passport.use(
    new GoogleStrategy(
      {
        clientID: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        callbackURL: config.GOOGLE_CALLBACK_URL,
        passReqToCallback: true,
      },
      async (_req, _accessToken, _refreshToken, profile: Profile, done) => {
        try {
          const db = getDatabase();
          const repo = new UserRepository(db);

          const email = profile.emails?.[0]?.value;
          if (!email) {
            logger.warn('Google login failed: no email returned by Google');
            return done(new Error('Google profile must include an email address'), undefined);
          }

          // 1. Try to find user by google_sub
          let user = await repo.findByGoogleSub(profile.id);

          if (!user) {
            // 2. Try to find by email (if they registered locally first, or something)
            user = await repo.findByEmail(email);

            if (user) {
              // Upgrade their account with Google Sub
              await db('users').where({ id: user.id }).update({
                google_sub: profile.id,
                auth_provider: 'google', // Upgrade to google auth
              });
              user.googleSub = profile.id;
              user.authProvider = 'google';
            } else {
              // 3. New user registration automatically!
              user = await repo.create({
                email,
                name: profile.displayName,
                passwordHash: null,
                authProvider: 'google',
                googleSub: profile.id,
                role: 'user',
                isActive: true,
              });
              logger.info({ userId: user.id }, 'New user registered via Google OAuth');
            }
          }

          if (!user.isActive) {
            return done(new Error('Account is deactivated'), undefined);
          }

          // In a stateless JWT architecture, we just pass the user out of the strategy
          // The route handler will sign the JWTs.
          return done(null, user);
        } catch (err: any) {
          logger.error({ err }, 'Error in GoogleStrategy verify callback');
          return done(err, undefined);
        }
      },
    ),
  );
}
