// Sample JavaScript file for chunking integration tests

/**
 * Utility functions for data processing
 */
function validateEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

function processUsers(users) {
  return users
    .filter(user => validateEmail(user.email))
    .map(user => ({
      id: user.id,
      name: user.name,
      email: user.email.toLowerCase()
    }));
}

// Database connection
const db = {
  connect() {
    console.log('Connecting to database...');
    return Promise.resolve({ status: 'connected' });
  },

  async saveUser(user) {
    const connection = await this.connect();

    if (user.age < 18) {
      throw new Error('User must be 18 or older');
    }

    return {
      ...user,
      id: Date.now(),
      createdAt: new Date()
    };
  }
};

// Export utilities
export { validateEmail, processUsers, db };
