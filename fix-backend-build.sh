#!/bin/bash

# Fix script for backend build errors
# This script regenerates the Prisma client and validates the schema

echo "🔧 Starting backend fix process..."
echo ""

# Navigate to backend directory
cd backend

# Step 1: Validate the schema
echo "📋 Step 1: Validating Prisma schema..."
npx prisma validate
if [ $? -ne 0 ]; then
    echo "❌ Schema validation failed. Please check the schema.prisma file."
    exit 1
fi
echo "✅ Schema validation passed"
echo ""

# Step 2: Generate Prisma client
echo "🔨 Step 2: Generating Prisma client..."
npx prisma generate
if [ $? -ne 0 ]; then
    echo "❌ Prisma client generation failed."
    exit 1
fi
echo "✅ Prisma client generated successfully"
echo ""

# Step 3: Check for TypeScript errors
echo "🔍 Step 3: Checking TypeScript compilation..."
npx tsc --noEmit
if [ $? -ne 0 ]; then
    echo "⚠️  TypeScript compilation has errors. See above for details."
    echo ""
    echo "Common fixes:"
    echo "1. Make sure all imports are correct"
    echo "2. Check that Prisma types match your code"
    echo "3. Run 'npm install' if dependencies are missing"
    exit 1
fi
echo "✅ TypeScript compilation successful"
echo ""

# Step 4: Try building
echo "🏗️  Step 4: Building the project..."
npm run build
if [ $? -ne 0 ]; then
    echo "❌ Build failed. Please check the errors above."
    exit 1
fi
echo "✅ Build successful!"
echo ""

echo "🎉 All fixes applied successfully!"
echo ""
echo "You can now start the backend with:"
echo "  npm run dev"
