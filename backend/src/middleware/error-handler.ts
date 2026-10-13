import { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number = 500, isOperational: boolean = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  error: FastifyError | ZodError | AppError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) => {
  // Zod validation errors
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: 'Validation Error',
      message: 'Invalid request data',
      details: error.errors.map((err) => ({
        field: err.path.join('.'),
        message: err.message,
      })),
    });
  }

  // Custom application errors
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: error.name,
      message: error.message,
    });
  }

  // Fastify validation errors
  if (error.validation) {
    return reply.status(400).send({
      error: 'Validation Error',
      message: 'Invalid request data',
      details: error.validation,
    });
  }

  // Prisma errors
  if (error.name === 'PrismaClientKnownRequestError') {
    const prismaError = error as any;
    
    // Unique constraint violation
    if (prismaError.code === 'P2002') {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Resource already exists',
        details: prismaError.meta,
      });
    }

    // Record not found
    if (prismaError.code === 'P2025') {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Resource not found',
      });
    }
  }

  // Default error
  request.log.error(error);

  return reply.status(500).send({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
  });
};
