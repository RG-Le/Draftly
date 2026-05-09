import { getDatabase, createDatabase } from './dist/infrastructure/database/connection.js';
import { loadConfig } from './dist/config/index.js';
import { TokenService } from './dist/domain/auth/token.service.js';
import fetch from 'node-fetch';

async function run() {
  const config = loadConfig();
  createDatabase(config);
  const db = getDatabase();

  const user = await db('users').first();
  if (!user) {
    console.log('No user found to test with.');
    process.exit(0);
  }

  // Assuming keys are loaded in app.ts, we need keys
  // For local testing, we can just hit the API with a valid token if we can generate one.
  // Actually, we don't have the keys easily available here unless we initialize the key pair.
  console.log(`User found: ${user.email}`);
  
  // Let's just test DB operations to ensure the schema allows personalized_profile
  try {
    const profile = await db('user_profiles').where({ user_id: user.id }).first();
    console.log('Current profile:', profile);
    
    if (!profile) {
      await db('user_profiles').insert({
        user_id: user.id,
        preferred_tone: 'friendly',
        personalized_profile: 'This is a test profile',
        signature_template: 'Best,\nTest User'
      });
      console.log('Inserted test profile');
    } else {
      await db('user_profiles').where({ user_id: user.id }).update({
        personalized_profile: 'Updated personalized profile',
        signature_template: 'Regards,\nTest User'
      });
      console.log('Updated test profile');
    }
    
    const updatedProfile = await db('user_profiles').where({ user_id: user.id }).first();
    console.log('Final profile:', updatedProfile);
  } catch (err) {
    console.error('Error during DB operations:', err);
  }

  process.exit(0);
}

run();
