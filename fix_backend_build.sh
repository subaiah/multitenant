#!/bin/bash

# Backend Build Fix Script
# This script fixes all TypeScript compilation errors

set -e  # Exit on error

echo "🔧 Starting Backend Build Fix..."
echo ""

# Navigate to backend directory
cd backend

# Step 1: Check if node_modules exists
echo "📦 Step 1: Checking dependencies..."
if [ ! -d "node_modules" ]; then
    echo "❌ node_modules not found. Installing dependencies..."
    npm install
else
    echo "✅ Dependencies found"
fi

# Step 2: Generate Prisma client
echo ""
echo "🔧 Step 2: Generating Prisma client..."
npx prisma generate
echo "✅ Prisma client generated"

# Step 3: Verify type definition files exist
echo ""
echo "📝 Step 3: Verifying type definitions..."
if [ ! -f "src/global.d.ts" ]; then
    echo "❌ src/global.d.ts not found!"
    exit 1
fi
echo "✅ Type definitions found"

# Step 4: Clean previous build
echo ""
echo "🧹 Step 4: Cleaning previous build..."
rm -rf dist
echo "✅ Build cleaned"

# Step 5: Run TypeScript build
echo ""
echo "🏗️  Step 5: Building backend..."
if npm run build; then
    echo ""
    echo "✅ ✅ ✅ BUILD SUCCESSFUL! ✅ ✅ ✅"
    echo ""
    echo "📊 Build completed with 0 errors"
    echo "📁 Output directory: dist/"
    echo ""
    echo "🚀 Next steps:"
    echo "   1. Start server: npm run dev"
    echo "   2. Test health: curl http://localhost:4000/health"
    echo ""
else
    echo ""
    echo "❌ BUILD FAILED"
    echo ""
    echo "📝 Checking for common errors..."
    
    # Check for specific error patterns
    if npm run build 2>&1 | grep -q "Cannot find module '@prisma/client'"; then
        echo "⚠️  Prisma client not found. Try: npx prisma generate"
    fi
    
    if npm run build 2>&1 | grep -q "Property 'user' does not exist"; then
        echo "⚠️  Type definitions not loaded. Check src/global.d.ts"
    fi
    
    if npm run build 2>&1 | grep -q "Cannot find name 'UserType'"; then
        echo "⚠️  UserType not imported. Check src/global.d.ts imports"
    fi
    
    echo ""
    echo "📖 For detailed troubleshooting, see: FIX_BACKEND_BUILD.md"
    exit 1
fi
